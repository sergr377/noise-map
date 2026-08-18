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
import groovy.sql.Sql
import org.h2gis.api.ProgressVisitor
import org.noise_planet.noisemodelling.scripts.Acoustic_Tools.Create_Isosurface
import org.noise_planet.noisemodelling.scripts.Geometric_Tools.Change_SRID
import org.noise_planet.noisemodelling.scripts.Import_and_Export.Export_Table
import org.noise_planet.noisemodelling.scripts.Import_and_Export.Import_Asc_File
import org.noise_planet.noisemodelling.scripts.Import_and_Export.Import_File
import org.noise_planet.noisemodelling.scripts.Import_and_Export.Import_OSM
import org.noise_planet.noisemodelling.scripts.NoiseModelling.Noise_level_from_source
import org.noise_planet.noisemodelling.scripts.NoiseModelling.Noise_level_from_traffic
import org.noise_planet.noisemodelling.scripts.NoiseModelling.Railway_Emission_from_Traffic
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

    Sql sql = new Sql(connection)

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

    // 1b. Optional terrain. The raster arrives in WGS84 and is reprojected into
    //     the working CRS, because propagation needs every layer in the same
    //     metric system.
    boolean withDem = p.demFile != null && !(p.demFile as String).isEmpty()
    if (withDem) {
        new Import_Asc_File().exec(connection, [
                pathFile  : p.demFile as String,
                inputSRID : 4326
        ])
        new Change_SRID().exec(connection, [tableName: 'DEM', newSRID: p.srid as Integer])
        stamp('Import_Asc_File')
    }

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
    def noiseInputs = [
            tableBuilding     : 'BUILDINGS',
            tableRoads        : 'ROADS',
            tableReceivers    : 'RECEIVERS',
            tableGroundAbs    : 'GROUND',
            confMaxSrcDist    : p.maxSrcDist as Double,
            confDiffVertical  : p.diffVertical as Boolean,
            confDiffHorizontal: p.diffHorizontal as Boolean,
            confReflOrder     : p.reflOrder as Integer,
            confThreadNumber  : 0
    ]
    if (withDem) {
        noiseInputs['tableDEM'] = 'DEM'
    }

    def res = new Noise_level_from_traffic().exec(connection, noiseInputs, pv)
    stamp('Noise_level_from_traffic')
    logger.info('levels table: {}', res.result)

    // 3b. Optional railway contribution — UNFINISHED, see the README.
    //     The emission step below works; the propagation pass after it does not
    //     complete in reasonable time, so this branch is off by default and is
    //     not exposed through the HTTP layer.
    //
    //     Rail runs as a second propagation pass rather than as extra sources in
    //     the first: the road path is the proven one, and keeping it untouched
    //     means enabling rail cannot change a road-only result. The two passes
    //     are then summed energetically, which is how independent sources
    //     combine — arithmetic averaging of decibels would be meaningless.
    if (p.railFile != null && !(p.railFile as String).isEmpty()) {
        new Import_File().exec(connection, [
                pathFile : p.railFile as String,
                inputSRID: 4326,
                tableName: 'RAIL_IMPORT'
        ])
        new Change_SRID().exec(connection, [tableName: 'RAIL_IMPORT', newSRID: p.srid as Integer])

        sql.execute('DROP TABLE IF EXISTS RAIL_SECTIONS')
        sql.execute('''
            CREATE TABLE RAIL_SECTIONS AS
            SELECT CAST(ROW_NUMBER() OVER () AS INTEGER) AS IDSECTION,
                   THE_GEOM, NTRACK, TRACKSPD, TRANSFER, ROUGHNESS,
                   IMPACT, CURVATURE, BRIDGE, ISTUNNEL
            FROM RAIL_IMPORT
        ''')
        // CREATE TABLE AS SELECT leaves columns nullable in H2, and a primary
        // key will not accept that.
        sql.execute('ALTER TABLE RAIL_SECTIONS ALTER COLUMN IDSECTION SET NOT NULL')
        sql.execute('ALTER TABLE RAIL_SECTIONS ADD PRIMARY KEY (IDSECTION)')

        // Train counts come from the caller: OpenStreetMap carries no timetable,
        // and unlike roads there is no official default table to fall back on.
        sql.execute('DROP TABLE IF EXISTS RAIL_TRAFFIC')
        sql.execute("""
            CREATE TABLE RAIL_TRAFFIC AS
            SELECT IDSECTION AS IDTRAFFIC, IDSECTION,
                   '${p.trainType}' AS TRAINTYPE,
                   TRACKSPD AS TRAINSPD,
                   ${p.trainsDay as Integer} AS TDAY,
                   ${p.trainsEvening as Integer} AS TEVENING,
                   ${p.trainsNight as Integer} AS TNIGHT
            FROM RAIL_SECTIONS
        """ as String)
        sql.execute('ALTER TABLE RAIL_TRAFFIC ALTER COLUMN IDTRAFFIC SET NOT NULL')
        sql.execute('ALTER TABLE RAIL_TRAFFIC ADD PRIMARY KEY (IDTRAFFIC)')

        def sections = sql.firstRow('SELECT COUNT(*) AS n FROM RAIL_SECTIONS').n
        logger.info('[RAIL] {} sections, {} trains/h day', sections, p.trainsDay)

        new Railway_Emission_from_Traffic().exec(connection, [
                tableRailwayTraffic: 'RAIL_TRAFFIC',
                tableRailwayTrack  : 'RAIL_SECTIONS'
        ])
        stamp('Railway_Emission_from_Traffic')

        sql.execute('DROP TABLE IF EXISTS ROAD_LEVEL')
        sql.execute('ALTER TABLE RECEIVERS_LEVEL RENAME TO ROAD_LEVEL')

        // LW_RAILWAY is self-contained: Railway_Emission_from_Traffic writes
        // geometry alongside third-octave levels per period (HZD*/HZE*/HZN*), so
        // it goes in as the sources table rather than as a separate emission one.
        new Noise_level_from_source().exec(connection, [
                tableBuilding         : 'BUILDINGS',
                tableSources          : 'LW_RAILWAY',
                tableReceivers        : 'RECEIVERS',
                tableGroundAbs        : 'GROUND',
                confMaxSrcDist        : p.maxSrcDist as Double,
                confDiffVertical      : p.diffVertical as Boolean,
                confDiffHorizontal    : p.diffHorizontal as Boolean,
                confReflOrder         : p.reflOrder as Integer,
                confThreadNumber      : 0
        ], pv)
        stamp('Noise_level_from_source (rail)')

        sql.execute('DROP TABLE IF EXISTS RAIL_LEVEL')
        sql.execute('ALTER TABLE RECEIVERS_LEVEL RENAME TO RAIL_LEVEL')

        // Energetic sum, band by band. Road is the base: it covers every
        // receiver, while a receiver out of range of any track has no rail row.
        def bands = ['HZ63', 'HZ125', 'HZ250', 'HZ500', 'HZ1000', 'HZ2000', 'HZ4000', 'HZ8000', 'LAEQ', 'LEQ']
        def sums = bands.collect { band ->
            "10 * LOG10(POWER(10, r.${band} / 10) + POWER(10, COALESCE(t.${band}, -99) / 10)) AS ${band}"
        }.join(',\n                   ')

        sql.execute('DROP TABLE IF EXISTS RECEIVERS_LEVEL')
        sql.execute("""
            CREATE TABLE RECEIVERS_LEVEL AS
            SELECT r.IDRECEIVER, r.PERIOD, r.THE_GEOM,
                   ${sums}
            FROM ROAD_LEVEL r
            LEFT JOIN RAIL_LEVEL t
              ON r.IDRECEIVER = t.IDRECEIVER AND r.PERIOD = t.PERIOD
        """ as String)
        stamp('Combine road + rail')
    }

    // 4. Isosurfaces. Bands follow the NF S31-133 / END convention.
    new Create_Isosurface().exec(connection, [
            resultTable     : 'RECEIVERS_LEVEL',
            resultTableField: 'LAEQ',
            isoClass        : p.isoClass as String,
            smoothCoefficient: 1.0d
    ], pv)
    stamp('Create_Isosurface')

    // 5. Dissolve. Create_Isosurface emits one polygon per Delaunay cell, so a
    //    single noise band arrives as hundreds of adjacent fragments that share
    //    edges. Merging them per (period, level) collapses that into a handful of
    //    multipolygons and removes all the interior seams.
    //
    //    ST_Buffer(geom, 0) repairs self-intersections that would otherwise make
    //    ST_Union throw; simplification runs here, while coordinates are still in
    //    metres, so the tolerance is a real distance rather than a degree fraction.
    sql.execute('DROP TABLE IF EXISTS CONTOURING_DISSOLVED')
    sql.execute("""
        CREATE TABLE CONTOURING_DISSOLVED AS
        SELECT ST_SIMPLIFYPRESERVETOPOLOGY(
                   ST_UNION(ST_ACCUM(ST_BUFFER(THE_GEOM, 0))),
                   ${p.simplifyTolerance as Double}
               ) AS THE_GEOM,
               PERIOD, ISOLVL, ISOLABEL
        FROM CONTOURING_NOISE_MAP
        GROUP BY PERIOD, ISOLVL, ISOLABEL
    """ as String)

    def before = sql.firstRow('SELECT COUNT(*) AS n FROM CONTOURING_NOISE_MAP').n
    def after = sql.firstRow('SELECT COUNT(*) AS n FROM CONTOURING_DISSOLVED').n
    logger.info('[DISSOLVE] {} polygons -> {} multipolygons', before, after)
    stamp('Dissolve')

    // 6. Reproject to WGS84 — the metric SRID is a calculation detail, web maps want 4326.
    new Change_SRID().exec(connection, [
            tableName: 'CONTOURING_DISSOLVED',
            newSRID  : 4326
    ])
    stamp('Change_SRID')

    new Export_Table().exec(connection, [
            tableToExport: 'CONTOURING_DISSOLVED',
            exportPath   : p.outFile as String
    ])
    stamp('Export_Table')

    return p.outFile as String
}
