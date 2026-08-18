/**
 * Orchestration script for NoiseModelling 6.x, run via bin/ScriptRunner.
 *
 * Chains the stock WPS blocks into one job:
 *   Import_OSM -> Delaunay_Grid -> Noise_level_from_traffic
 *   -> Create_Isosurface -> Change_SRID -> Export_Table
 *
 * Parameters are read from the JSON file pointed at by the NM_PARAMS
 * environment variable, because ScriptRunner has no way to pass arbitrary
 * arguments through to the script.
 */

import groovy.json.JsonSlurper
import org.h2gis.api.ProgressVisitor
import org.noise_planet.noisemodelling.scripts.Acoustic_Tools.Create_Isosurface
import org.noise_planet.noisemodelling.scripts.Geometric_Tools.Change_SRID
import org.noise_planet.noisemodelling.scripts.Import_and_Export.Export_Table
import org.noise_planet.noisemodelling.scripts.Import_and_Export.Import_OSM
import org.noise_planet.noisemodelling.scripts.NoiseModelling.Noise_level_from_traffic
import org.noise_planet.noisemodelling.scripts.Receivers.Delaunay_Grid
import org.slf4j.Logger
import org.slf4j.LoggerFactory

import java.sql.Connection

title = 'Noise map pipeline'
description = 'OSM extract -> CNOSSOS-EU road noise -> isosurfaces as WGS84 GeoJSON'

inputs = [:]

outputs = [
        result: [name: 'result', title: 'result', description: 'Path of the exported GeoJSON', type: String.class]
]

def exec(Connection connection, Map input, ProgressVisitor progress) {
    Logger logger = LoggerFactory.getLogger('noisemap.pipeline')

    String paramsPath = System.getenv('NM_PARAMS')
    if (paramsPath == null || paramsPath.isEmpty()) {
        throw new IllegalStateException('NM_PARAMS environment variable is not set')
    }
    def p = new JsonSlurper().parse(new File(paramsPath))
    logger.info('pipeline params: {}', p)

    // Only the two heavy blocks take a ProgressVisitor overload; the rest are
    // exec(Connection, input) and would throw MissingMethodException on 3 args.
    ProgressVisitor pv = progress.subProcess(2)
    long t0 = System.currentTimeMillis()
    def stamp = { String step ->
        logger.info('[TIMING] {} done at {} ms', step, System.currentTimeMillis() - t0)
    }

    // 1. Buildings, roads (with WG-AEN default traffic) and ground absorption.
    //    Tunnels are dropped: a road inside a tunnel is not a surface noise source.
    new Import_OSM().exec(connection, [
            pathFile               : p.osmFile as String,
            targetSRID             : p.srid as Integer,
            removeTunnels          : true,
            eliminateNoTrafficRoads: true
    ])
    stamp('Import_OSM')

    // 2. Receiver mesh. Delaunay (not Regular_Grid) is required because
    //    Create_Isosurface consumes the TRIANGLES table this block emits.
    //    The fence keeps receivers inside the area we actually display, while
    //    ROADS still holds every source out to the extract radius. Without it we
    //    would compute a full square of receivers to show a smaller disc.
    new Delaunay_Grid().exec(connection, [
            tableBuilding   : 'BUILDINGS',
            sourcesTableName: 'ROADS',
            outputTableName : 'RECEIVERS',
            fence           : p.fenceWkt as String,
            maxArea         : p.maxArea as Double,
            maxCellDist     : 600.0d,
            height          : 4.0d
    ])
    stamp('Delaunay_Grid')

    // 3. CNOSSOS-EU propagation.
    //    Diffraction is off by default in NoiseModelling; without it, courtyards
    //    come out as loud as the street they hide behind, so enable it explicitly.
    def res = new Noise_level_from_traffic().exec(connection, [
            tableBuilding     : 'BUILDINGS',
            tableRoads        : 'ROADS',
            tableReceivers    : 'RECEIVERS',
            tableGroundAbs    : 'GROUND',
            confMaxSrcDist    : p.maxSrcDist as Double,
            confDiffVertical  : p.diffVertical as Boolean,
            confDiffHorizontal: p.diffHorizontal as Boolean,
            confReflOrder     : p.reflOrder as Integer,
            confThreadNumber  : 0
    ], pv)
    stamp('Noise_level_from_traffic')
    logger.info('levels table: {}', res.result)

    // 4. Isosurfaces. Bands follow the NF S31-133 / END convention.
    new Create_Isosurface().exec(connection, [
            resultTable     : 'RECEIVERS_LEVEL',
            resultTableField: 'LAEQ',
            isoClass        : p.isoClass as String,
            smoothCoefficient: 1.0d
    ], pv)
    stamp('Create_Isosurface')

    // 5. Reproject to WGS84 — the metric SRID is a calculation detail, web maps want 4326.
    new Change_SRID().exec(connection, [
            tableName: 'CONTOURING_NOISE_MAP',
            newSRID  : 4326
    ])
    stamp('Change_SRID')

    new Export_Table().exec(connection, [
            tableToExport: 'CONTOURING_NOISE_MAP',
            exportPath   : p.outFile as String
    ])
    stamp('Export_Table')

    return p.outFile as String
}
