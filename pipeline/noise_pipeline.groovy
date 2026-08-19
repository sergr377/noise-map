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
import org.h2gis.api.EmptyProgressVisitor
import org.h2gis.api.ProgressVisitor
import org.noise_planet.noisemodelling.jdbc.utils.IsoSurface
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
import java.sql.DriverManager
import java.util.concurrent.atomic.AtomicBoolean

title = 'Noise map pipeline'
description = 'OSM extract -> CNOSSOS-EU road noise -> isosurfaces as WGS84 GeoJSON'

inputs = [:]

outputs = [
        result: [name: 'result', title: 'result', description: 'Path of the exported GeoJSON', type: String.class]
]

/**
 * Диск зоны показа в рабочей проекции. Приёмники всегда заполняют описанный
 * квадрат — Delaunay_Grid берёт от fence только envelope, — поэтому круг
 * вырезается из готовых изофон.
 */
String discExpression(Map p) {
    return "ST_BUFFER(ST_TRANSFORM(ST_SETSRID(" +
            "ST_GEOMFROMTEXT('POINT(${p.centreLon} ${p.centreLat})'), 4326), ${p.srid}), " +
            "${p.radius as Double}, 'quad_segs=16')"
}

/**
 * Склейка обрезков в мультиполигоны, обрезка по кругу, перепроецирование и
 * выгрузка. Общая для финального результата и для частичных кадров: разойтись
 * этим двум путям нельзя — иначе кадр покажет не то, что окажется в ответе.
 *
 * ST_Buffer(geom, 0) чинит самопересечения, из-за которых ST_Union бросает
 * исключение; упрощение идёт до перепроецирования, пока координаты в метрах,
 * иначе допуск пришлось бы задавать в долях градуса. Обрезка — последней, после
 * упрощения, чтобы кромка круга осталась ровной, и ещё один ST_Buffer(...,0)
 * поверх пересечения убирает вырожденные линии и точки: фронтенд читает Polygon
 * и MultiPolygon, а GeometryCollection его сломает.
 */
Map dissolveClipExport(Connection c, Map p, String contourTable, String dissolvedTable, String outPath) {
    Sql sql = new Sql(c)
    String disc = discExpression(p)

    sql.execute("DROP TABLE IF EXISTS ${dissolvedTable}" as String)
    sql.execute("""
        CREATE TABLE ${dissolvedTable} AS
        SELECT ST_BUFFER(
                   ST_INTERSECTION(
                       ST_SIMPLIFYPRESERVETOPOLOGY(
                           ST_UNION(ST_ACCUM(ST_BUFFER(THE_GEOM, 0))),
                           ${p.simplifyTolerance as Double}
                       ),
                       ${disc}
                   ),
                   0
               ) AS THE_GEOM,
               PERIOD, ISOLVL, ISOLABEL
        FROM ${contourTable}
        GROUP BY PERIOD, ISOLVL, ISOLABEL
    """ as String)

    // Диапазон, целиком лежащий вне круга, переживает обрезку пустой геометрией,
    // которая выгрузилась бы фичей без координат.
    int emptied = sql.executeUpdate(
            "DELETE FROM ${dissolvedTable} WHERE THE_GEOM IS NULL OR ST_ISEMPTY(THE_GEOM)" as String)

    int before = sql.firstRow("SELECT COUNT(*) AS n FROM ${contourTable}" as String).n as Integer
    int after = sql.firstRow("SELECT COUNT(*) AS n FROM ${dissolvedTable}" as String).n as Integer

    // Метрическая проекция — деталь расчёта, вебу нужен 4326.
    new Change_SRID().exec(c, [tableName: dissolvedTable, newSRID: 4326])
    new Export_Table().exec(c, [tableToExport: dissolvedTable, exportPath: outPath])

    return [before: before, after: after, emptied: emptied]
}

/**
 * Живой рендер: пока идёт распространение, периодически строит изофоны по уже
 * посчитанной части приёмников и выгружает их отдельными файлами.
 *
 * Это возможно потому, что NoiseModelling пишет результаты не в конце, а по
 * ходу: NoiseMapWriter отдельным потоком сливает их батчами и коммитит.
 * Измерено на копии готовой базы — таблица росла 6 148 -> 41 880 -> 132 548
 * строк, пока расчёт ещё шёл. Второе соединение к встроенной H2 из того же JVM
 * при этом открывается штатно.
 *
 * Кадр строится не блоком Create_Isosurface, а классом IsoSurface напрямую:
 * блок работает с фиксированными именами таблиц, а кадру нужен свой набор
 * треугольников и своя таблица вывода, чтобы не мешать финальному проходу.
 */
Thread startPartialWatcher(Connection main, Map p, Logger logger, AtomicBoolean stop, int intervalMs) {
    // Читается на главном потоке: у второго соединения свои метаданные будут
    // только после того, как оно откроется.
    String url = main.getMetaData().getURL()
    String user = main.getMetaData().getUserName()

    return Thread.start('partial-frames') {
        Connection c = null
        try {
            c = ['sa', ''].findResult { pwd ->
                try { DriverManager.getConnection(url, user, pwd) } catch (Exception ignored) { null }
            }
            if (c == null) {
                logger.warn('[PARTIAL] второе соединение не открылось — живой рендер выключен')
                return
            }
            Sql sql = new Sql(c)
            // Кадр — украшение, и он не имеет права застопорить расчёт: любой
            // запрос, ушедший в патологический план, обязан упасть сам.
            sql.execute('SET QUERY_TIMEOUT 60000')
            List<Double> isoLevels = (p.isoClass as String).split(',').collect { Double.parseDouble(it.trim()) }

            int frame = 0
            long shownReceivers = 0
            long sleepMs = intervalMs

            while (!stop.get()) {
                // Спим кусочками, иначе join после расчёта ждал бы целый интервал.
                for (long slept = 0; slept < sleepMs && !stop.get(); slept += 500) {
                    Thread.sleep(500)
                }
                if (stop.get()) break

                long frameStart = System.currentTimeMillis()
                try {
                    // Приёмник готов, когда у него есть строки на все периоды:
                    // писатель кладёт их вместе, и частично заполненный приёмник
                    // дал бы кадр, где у одного периода дырки, а у другого нет.
                    int periods = Math.max(1,
                            sql.firstRow('SELECT COUNT(DISTINCT PERIOD) AS n FROM RECEIVERS_LEVEL').n as Integer)
                    sql.execute('DROP TABLE IF EXISTS PARTIAL_READY')
                    sql.execute("""
                        CREATE TABLE PARTIAL_READY AS
                        SELECT IDRECEIVER FROM RECEIVERS_LEVEL
                        GROUP BY IDRECEIVER HAVING COUNT(*) >= ${periods}
                    """ as String)
                    // Без ключа H2 перебирает готовых приёмников заново на
                    // каждый треугольник, и кадр не достраивается никогда —
                    // проверено, поток вставал в этом запросе на минуты.
                    sql.execute('ALTER TABLE PARTIAL_READY ALTER COLUMN IDRECEIVER SET NOT NULL')
                    sql.execute('ALTER TABLE PARTIAL_READY ADD PRIMARY KEY (IDRECEIVER)')
                    long ready = sql.firstRow('SELECT COUNT(*) AS n FROM PARTIAL_READY').n as Long

                    // Кадр, отличающийся от предыдущего на несколько процентов,
                    // не стоит своей цены: он считается в том же JVM и отнимает
                    // ядра у расчёта.
                    if (ready < 500 || ready < shownReceivers * 1.15) {
                        continue
                    }

                    sql.execute('DROP TABLE IF EXISTS TRIANGLES_PARTIAL')
                    sql.execute("""
                        CREATE TABLE TRIANGLES_PARTIAL AS
                        SELECT t.* FROM TRIANGLES t
                        JOIN PARTIAL_READY a ON a.IDRECEIVER = t.PK_1
                        JOIN PARTIAL_READY b ON b.IDRECEIVER = t.PK_2
                        JOIN PARTIAL_READY d ON d.IDRECEIVER = t.PK_3
                    """)
                    // CREATE TABLE AS SELECT оставляет колонки nullable, а
                    // первичный ключ этого не примет.
                    sql.execute('ALTER TABLE TRIANGLES_PARTIAL ALTER COLUMN PK SET NOT NULL')
                    sql.execute('ALTER TABLE TRIANGLES_PARTIAL ADD PRIMARY KEY (PK)')
                    long triangles = sql.firstRow('SELECT COUNT(*) AS n FROM TRIANGLES_PARTIAL').n as Long
                    if (triangles < 20) continue

                    // Снимок уровней вместо живой таблицы. Ключ на
                    // RECEIVERS_LEVEL движок ставит только после последней
                    // ячейки, поэтому во время расчёта каждый поиск приёмника в
                    // ней — полный скан, и построение изофон не заканчивается
                    // никогда: замерено, поток стоял в IsoSurface минутами.
                    // Копия готовых строк стоит секунду и снимает заодно вопрос
                    // о чтении таблицы, в которую в этот момент пишут.
                    sql.execute('DROP TABLE IF EXISTS PARTIAL_LEVELS')
                    sql.execute('''
                        CREATE TABLE PARTIAL_LEVELS AS
                        SELECT l.* FROM RECEIVERS_LEVEL l
                        JOIN PARTIAL_READY r ON r.IDRECEIVER = l.IDRECEIVER
                    ''')
                    sql.execute('CREATE INDEX PARTIAL_LEVELS_IDX ON PARTIAL_LEVELS(IDRECEIVER)')

                    sql.execute('DROP TABLE IF EXISTS CONTOURING_PARTIAL')
                    IsoSurface iso = new IsoSurface(isoLevels, p.srid as Integer)
                    iso.setPointTable('PARTIAL_LEVELS')
                    iso.setPointTableField('LAEQ')
                    iso.setTriangleTable('TRIANGLES_PARTIAL')
                    iso.setOutputTable('CONTOURING_PARTIAL')
                    iso.setSmooth(true)
                    iso.setSmoothCoefficient(1.0d)
                    // Свой прогресс кадра не должен попадать в общий поток: его
                    // проценты HTTP-слой принял бы за прогресс расчёта.
                    iso.setProgressVisitor(new EmptyProgressVisitor())
                    iso.createTable(c, 'IDRECEIVER')

                    frame += 1
                    String outPath = new File(new File(p.outFile as String).getParentFile(),
                            "partial-${frame}.geojson").getAbsolutePath()
                    def stats = dissolveClipExport(c, p, 'CONTOURING_PARTIAL', 'CONTOURING_PARTIAL_DISSOLVED', outPath)
                    shownReceivers = ready

                    long cost = System.currentTimeMillis() - frameStart
                    // Кадры не должны стоить больше десятой части расчёта,
                    // поэтому пауза растёт вместе с ценой кадра.
                    sleepMs = Math.max(intervalMs, cost * 9)
                    logger.info('[PARTIAL] {} ({} приёмников, {} контуров, {} мс)',
                            outPath, ready, stats.after, cost)
                } catch (Exception e) {
                    // Кадр — украшение: расчёт из-за него падать не должен.
                    logger.warn('[PARTIAL] кадр не построился: {}', e.message)
                    sleepMs = Math.max(intervalMs, sleepMs)
                }
            }
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt()
        } finally {
            try {
                if (c != null) {
                    Sql cleanup = new Sql(c)
                    ['PARTIAL_READY', 'PARTIAL_LEVELS', 'TRIANGLES_PARTIAL', 'CONTOURING_PARTIAL',
                     'CONTOURING_PARTIAL_DISSOLVED'].each {
                        cleanup.execute("DROP TABLE IF EXISTS ${it}" as String)
                    }
                    c.close()
                }
            } catch (Exception ignored) {
            }
        }
    }
}

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

    // Живой рендер: кадры строятся, пока идёт распространение. Ноль выключает.
    int partialIntervalMs = (p.partialIntervalMs ?: 0) as Integer
    AtomicBoolean stopWatcher = new AtomicBoolean(false)
    Thread watcher = partialIntervalMs > 0
            ? startPartialWatcher(connection, p, logger, stopWatcher, partialIntervalMs)
            : null

    def res
    try {
        res = new Noise_level_from_traffic().exec(connection, noiseInputs, pv)
    } finally {
        // Наблюдатель обязан остановиться до финальных шагов: дальше таблицы
        // переименовываются и перепроецируются, и кадр посреди этого сломается.
        stopWatcher.set(true)
        watcher?.join()
    }
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

    // 5. Склейка, обрезка по кругу, перепроецирование и выгрузка.
    //    Create_Isosurface отдаёт по полигону на ячейку Делоне, поэтому один
    //    диапазон дБ приезжает сотнями смежных обрезков с общими рёбрами.
    //    Подробности — в dissolveClipExport: тот же путь проходят частичные
    //    кадры, и разойтись эти два пути не должны.
    def stats = dissolveClipExport(connection, p, 'CONTOURING_NOISE_MAP', 'CONTOURING_DISSOLVED',
            p.outFile as String)
    logger.info('[DISSOLVE] {} polygons -> {} multipolygons, {} emptied by the disc',
            stats.before, stats.after, stats.emptied)
    stamp('Dissolve')
    stamp('Export_Table')

    return p.outFile as String
}
