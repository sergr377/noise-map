/**
 * Synthetic benchmark for the railway propagation pass.
 *
 * Builds a small artificial scene (no OSM, no network) and runs the rail
 * propagation on it in several variants, one knob at a time, so the cost of
 * each can be attributed rather than guessed:
 *
 *   road        Noise_level_from_traffic on the same line — the reference
 *   rail3       LW_RAILWAY straight from the emission step: 24 third-octaves,
 *               6 co-located source rows per track, CNOSSOS train directivity.
 *               The exact reference every other variant is compared against,
 *               and slow on purpose — keep it last in a variant list
 *   railOct     the same, third-octaves collapsed energetically into 8 octaves
 *   rail3omni   24 bands, DIR_ID forced to 0 (omnidirectional)
 *   railOctOmni 8 bands, omnidirectional
 *   railOct2    8 bands, the 6 source rows merged into 2 (one per source
 *               height), omnidirectional
 *   rail3live   24 bands, directivity, source rows that carry no energy dropped
 *   railProd    what the pipeline actually feeds the propagation, built by
 *               calling noise_pipeline.groovy's own buildRailSources
 *
 * Timings and per-receiver level differences against rail3 are printed as
 * [BENCH] lines.
 */

import groovy.sql.Sql
import org.h2gis.api.EmptyProgressVisitor
import org.h2gis.api.ProgressVisitor
import org.noise_planet.noisemodelling.scripts.NoiseModelling.Noise_level_from_source
import org.noise_planet.noisemodelling.scripts.NoiseModelling.Noise_level_from_traffic
import org.noise_planet.noisemodelling.scripts.Receivers.Delaunay_Grid
import org.slf4j.Logger
import org.slf4j.LoggerFactory

import java.sql.Connection

title = 'Railway propagation benchmark'
description = 'Synthetic scene, rail propagation timed variant by variant'
inputs = [:]
outputs = [result: [name: 'result', title: 'result', description: 'report', type: String.class]]


def exec(Connection connection, Map input, ProgressVisitor progress) {
    Logger logger = LoggerFactory.getLogger('rail_bench')
    Sql sql = new Sql(connection)

    // Everything the pipeline already knows is taken from the pipeline: a
    // benchmark that measures a reimplementation stops saying anything about the
    // pipeline the moment the two drift apart.
    String pipelinePath = System.getenv('BENCH_PIPELINE') ?: 'pipeline/noise_pipeline.groovy'
    def pipeline = new GroovyShell().parse(new File(pipelinePath))
    Map<Integer, List<Integer>> OCTAVES = pipeline.invokeMethod('railOctaves', null) as Map

    int srid = 32637
    double x0 = 400000.0d, y0 = 6180000.0d
    double half = (System.getenv('BENCH_HALF') ?: '300') as double
    double maxSrcDist = (System.getenv('BENCH_MAXSRCDIST') ?: '350') as double
    double maxArea = (System.getenv('BENCH_MAXAREA') ?: '300') as double
    String variants = System.getenv('BENCH_VARIANTS') ?:
            'road,railProd,rail3live,railOct,railOct2,railOctOmni,rail3omni,rail3'
    StringBuilder report = new StringBuilder()
    def say = { String line ->
        logger.info('[BENCH] {}', line)
        report.append(line).append('\n')
    }

    // ---- scene -------------------------------------------------------------
    // One straight line through the middle carries both the road and the track,
    // so the two passes see the same geometry and the same receiver mesh.
    sql.execute('DROP TABLE IF EXISTS BUILDINGS')
    sql.execute("""CREATE TABLE BUILDINGS (PK INT NOT NULL PRIMARY KEY,
                   THE_GEOM GEOMETRY(POLYGON, ${srid}), HEIGHT DOUBLE PRECISION)""" as String)
    int pk = 0
    // A lattice of blocks on both sides of the corridor: without buildings the
    // pass has nothing to diffract around and the measurement says nothing about
    // a real city.
    for (int row = 1; row <= 5; row++) {
        double yc = 30 + row * 45
        for (int col = -6; col <= 6; col++) {
            double xc = col * 60
            for (int sign : [1, -1]) {
                double cx = x0 + xc, cy = y0 + sign * yc
                String wkt = "POLYGON((${cx - 18} ${cy - 9}, ${cx + 18} ${cy - 9}, " +
                        "${cx + 18} ${cy + 9}, ${cx - 18} ${cy + 9}, ${cx - 18} ${cy - 9}))"
                pk++
                sql.execute("INSERT INTO BUILDINGS VALUES (${pk}, ST_GeomFromText('${wkt}', ${srid}), 15.0)" as String)
            }
        }
    }
    say("buildings: ${pk}")

    String lineWkt = "LINESTRING(${x0 - half - 200} ${y0}, ${x0 + half + 200} ${y0})"

    sql.execute('DROP TABLE IF EXISTS ROADS')
    // The source geometry has to carry a Z: the loader refuses a source without
    // one. 0.05 m is the CNOSSOS road source height.
    sql.execute("""CREATE TABLE ROADS (PK INT NOT NULL PRIMARY KEY,
                   THE_GEOM GEOMETRY(LINESTRINGZ, ${srid}),
                   LV_D DOUBLE PRECISION, LV_E DOUBLE PRECISION, LV_N DOUBLE PRECISION,
                   HGV_D DOUBLE PRECISION, HGV_E DOUBLE PRECISION, HGV_N DOUBLE PRECISION,
                   LV_SPD_D DOUBLE PRECISION, LV_SPD_E DOUBLE PRECISION, LV_SPD_N DOUBLE PRECISION,
                   HGV_SPD_D DOUBLE PRECISION, HGV_SPD_E DOUBLE PRECISION, HGV_SPD_N DOUBLE PRECISION,
                   PVMT VARCHAR)""" as String)
    sql.execute("""INSERT INTO ROADS VALUES (1,
                   ST_UpdateZ(ST_Force3D(ST_GeomFromText('${lineWkt}', ${srid})), 0.05),
                   800, 400, 150, 40, 20, 10, 50, 50, 50, 50, 50, 50, 'NL08')""" as String)

    sql.execute('DROP TABLE IF EXISTS RAIL_SECTIONS')
    sql.execute("""CREATE TABLE RAIL_SECTIONS (IDSECTION INT NOT NULL PRIMARY KEY,
                   THE_GEOM GEOMETRY(LINESTRING, ${srid}), NTRACK INT, TRACKSPD DOUBLE PRECISION,
                   TRANSFER VARCHAR, ROUGHNESS VARCHAR, IMPACT VARCHAR, CURVATURE INT,
                   BRIDGE VARCHAR, ISTUNNEL BOOLEAN)""" as String)
    sql.execute('DROP TABLE IF EXISTS RAIL_TRAFFIC')
    sql.execute("""CREATE TABLE RAIL_TRAFFIC (IDTRAFFIC INT NOT NULL PRIMARY KEY, IDSECTION INT,
                   TRAINTYPE VARCHAR, TRAINSPD DOUBLE PRECISION, TDAY INT, TEVENING INT, TNIGHT INT)""" as String)
    // A bundle of parallel lines: one is a plain double track, thirty is the
    // station throat the branch actually died on.
    int nSections = (System.getenv('BENCH_SECTIONS') ?: '1') as int
    for (int i = 0; i < nSections; i++) {
        double dy = (i - (nSections - 1) / 2.0d) * 6.0d
        String wkt = "LINESTRING(${x0 - half - 200} ${y0 + dy}, ${x0 + half + 200} ${y0 + dy})"
        int id = i + 1
        sql.execute("""INSERT INTO RAIL_SECTIONS VALUES (${id}, ST_GeomFromText('${wkt}', ${srid}),
                       ${nSections == 1 ? 2 : 1}, 100.0, 'EU7', 'EU3', 'EU1', 0, '', FALSE)""" as String)
        sql.execute("INSERT INTO RAIL_TRAFFIC VALUES (${id}, ${id}, 'Z20500-5U1', 100.0, 6, 4, 2)" as String)
    }

    // EWKT, not plain WKT: Delaunay_Grid assumes a fence without an SRID is
    // WGS84 and reprojects it, which turns metric coordinates into an envelope
    // millions of metres wide and a grid of 16.7 million cells.
    String fence = "SRID=${srid};POLYGON((${x0 - half} ${y0 - half}, ${x0 + half} ${y0 - half}, " +
            "${x0 + half} ${y0 + half}, ${x0 - half} ${y0 + half}, ${x0 - half} ${y0 - half}))"
    new Delaunay_Grid().exec(connection, [
            tableBuilding   : 'BUILDINGS',
            sourcesTableName: 'ROADS',
            outputTableName : 'RECEIVERS',
            fence           : fence,
            maxArea         : maxArea,
            maxCellDist     : 600.0d,
            height          : 4.0d
    ])
    int nrec = sql.firstRow('SELECT COUNT(*) AS n FROM RECEIVERS').n
    say("receivers: ${nrec}, maxSrcDist: ${maxSrcDist}")

    // ---- emission ----------------------------------------------------------
    long t = System.currentTimeMillis()
    pipeline.invokeMethod('railEmission', [connection, sql, logger] as Object[])
    say("emission: ${System.currentTimeMillis() - t} ms, " +
            "${sql.firstRow('SELECT COUNT(DISTINCT PK_SECTION) AS n FROM LW_RAILWAY').n} of " +
            "${nSections} sections covered")

    // The propagation loader refuses a source table without an integer primary
    // key. The 6.0.0 distribution gives LW_RAILWAY one called PK; the sources at
    // the v6.0.0 tag do not, so add it only when it is missing.
    boolean hasPk = sql.firstRow("""SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.COLUMNS
                                    WHERE TABLE_NAME = 'LW_RAILWAY' AND COLUMN_NAME = 'PK'""").n > 0
    if (!hasPk) {
        sql.execute('ALTER TABLE LW_RAILWAY ADD COLUMN PK INT AUTO_INCREMENT')
        sql.execute('ALTER TABLE LW_RAILWAY ADD PRIMARY KEY (PK)')
    }
    int nsrc = sql.firstRow('SELECT COUNT(*) AS n FROM LW_RAILWAY').n
    int ncol = sql.firstRow("""SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.COLUMNS
                               WHERE TABLE_NAME = 'LW_RAILWAY'""").n
    say("LW_RAILWAY: ${nsrc} rows, ${ncol} columns")

    // Octave-collapsed copy. Summing the three third-octaves of an octave
    // energetically is exact for the emitted power; what it gives up is running
    // the propagation at third-octave resolution, which is what the road pass
    // gives up too.
    def octCols = []
    for (String period : ['D', 'E', 'N']) {
        OCTAVES.each { octave, thirds ->
            String terms = thirds.collect { "POWER(10, HZ${period}${it} / 10)" }.join(' + ')
            octCols << "10 * LOG10(${terms}) AS HZ${period}${octave}"
        }
    }
    sql.execute('DROP TABLE IF EXISTS LW_RAIL_OCT')
    sql.execute("""CREATE TABLE LW_RAIL_OCT AS SELECT PK, PK_SECTION, THE_GEOM, DIR_ID, GS,
                   ${octCols.join(', ')} FROM LW_RAILWAY""" as String)
    sql.execute('ALTER TABLE LW_RAIL_OCT ALTER COLUMN PK SET NOT NULL')
    sql.execute('ALTER TABLE LW_RAIL_OCT ADD PRIMARY KEY (PK)')

    // Omnidirectional copies of both.
    for (String src : ['LW_RAILWAY', 'LW_RAIL_OCT']) {
        sql.execute("DROP TABLE IF EXISTS ${src}_OMNI" as String)
        sql.execute("CREATE TABLE ${src}_OMNI AS SELECT * FROM ${src}" as String)
        sql.execute("UPDATE ${src}_OMNI SET DIR_ID = 0" as String)
        sql.execute("ALTER TABLE ${src}_OMNI ALTER COLUMN PK SET NOT NULL" as String)
        sql.execute("ALTER TABLE ${src}_OMNI ADD PRIMARY KEY (PK)" as String)
    }

    // Two rows per track instead of six: the six CNOSSOS source types sit at two
    // heights (0.5 m and 4 m), so merging by height keeps the geometry exact and
    // gives up only the per-type directivity.
    def sumCols = []
    for (String period : ['D', 'E', 'N']) {
        OCTAVES.keySet().each { octave ->
            sumCols << "10 * LOG10(SUM(POWER(10, HZ${period}${octave} / 10))) AS HZ${period}${octave}"
        }
    }
    sql.execute('DROP TABLE IF EXISTS LW_RAIL_OCT2')
    sql.execute("""CREATE TABLE LW_RAIL_OCT2 AS
                   SELECT CAST(ROW_NUMBER() OVER () AS INT) AS PK, PK_SECTION, THE_GEOM,
                          0 AS DIR_ID, MAX(GS) AS GS, ${sumCols.join(', ')}
                   FROM LW_RAIL_OCT
                   GROUP BY PK_SECTION, THE_GEOM""" as String)
    sql.execute('ALTER TABLE LW_RAIL_OCT2 ALTER COLUMN PK SET NOT NULL')
    sql.execute('ALTER TABLE LW_RAIL_OCT2 ADD PRIMARY KEY (PK)')
    say("LW_RAIL_OCT2: ${sql.firstRow('SELECT COUNT(*) AS n FROM LW_RAIL_OCT2').n} rows")

    // Silent rows dropped, third-octaves kept: this isolates the first of the
    // two savings. Every section gets all six CNOSSOS source types whether or
    // not the train and the track produce them — a suburban EMU at 100 km/h
    // emits nothing aerodynamic and is on no bridge — and a row more than
    // `floor` dB below the loudest row of its own section cannot move that
    // section's total by a thousandth of a decibel while costing a full share
    // of the propagation.
    double floorDb = (System.getenv('BENCH_FLOOR') ?: '40') as double
    def thirds = OCTAVES.values().flatten() as List<Integer>
    String rowMax = 'GREATEST(' +
            ['D', 'E', 'N'].collectMany { p -> thirds.collect { "HZ${p}${it}" } }.join(', ') + ')'
    sql.execute('DROP TABLE IF EXISTS LW_RAIL3_LIVE')
    sql.execute("""CREATE TABLE LW_RAIL3_LIVE AS
                   SELECT * FROM (
                     SELECT *, ${rowMax} AS ROWMAX,
                            MAX(${rowMax}) OVER (PARTITION BY PK_SECTION) AS SECTIONMAX
                     FROM LW_RAILWAY
                   ) WHERE ROWMAX >= SECTIONMAX - ${floorDb}""" as String)
    sql.execute('ALTER TABLE LW_RAIL3_LIVE DROP COLUMN ROWMAX')
    sql.execute('ALTER TABLE LW_RAIL3_LIVE DROP COLUMN SECTIONMAX')
    sql.execute('ALTER TABLE LW_RAIL3_LIVE ALTER COLUMN PK SET NOT NULL')
    sql.execute('ALTER TABLE LW_RAIL3_LIVE ADD PRIMARY KEY (PK)')
    def kept = sql.rows('SELECT DIR_ID, COUNT(*) AS n FROM LW_RAIL3_LIVE GROUP BY DIR_ID ORDER BY DIR_ID')
    say("LW_RAIL3_LIVE: ${sql.firstRow('SELECT COUNT(*) AS n FROM LW_RAIL3_LIVE').n} rows, " +
            'DIR_ID kept ' + kept.collect { "${it.DIR_ID}x${it.n}" }.join(' '))

    // The sources table the propagation actually gets.
    String prodTable = pipeline.invokeMethod('buildRailSources', [sql, logger, floorDb] as Object[])
    say("production sources: ${prodTable}, " +
            "${sql.firstRow("SELECT COUNT(*) AS n FROM ${prodTable}" as String).n} rows")

    // ---- runs --------------------------------------------------------------
    def base = [
            tableBuilding     : 'BUILDINGS',
            tableReceivers    : 'RECEIVERS',
            confMaxSrcDist    : maxSrcDist,
            confDiffVertical  : true,
            confDiffHorizontal: true,
            confReflOrder     : 1,
            confThreadNumber  : 0
    ]

    def run = { String name, Closure body ->
        sql.execute('DROP TABLE IF EXISTS RECEIVERS_LEVEL')
        long start = System.currentTimeMillis()
        body()
        long ms = System.currentTimeMillis() - start
        int rows = sql.firstRow('SELECT COUNT(*) AS n FROM RECEIVERS_LEVEL').n
        def stat = sql.firstRow("SELECT AVG(LAEQ) AS a, MAX(LAEQ) AS m FROM RECEIVERS_LEVEL WHERE PERIOD = 'D'")
        say(String.format('%-12s %7d ms  %6d rows  LAEQ avg %.2f max %.2f',
                name, ms, rows, (stat.a ?: 0) as double, (stat.m ?: 0) as double))
        sql.execute("DROP TABLE IF EXISTS LVL_${name.toUpperCase()}" as String)
        sql.execute("ALTER TABLE RECEIVERS_LEVEL RENAME TO LVL_${name.toUpperCase()}" as String)
    }

    Map<String, String> railTables = [
            rail3      : 'LW_RAILWAY',
            railOct    : 'LW_RAIL_OCT',
            rail3omni  : 'LW_RAILWAY_OMNI',
            railOctOmni: 'LW_RAIL_OCT_OMNI',
            railOct2   : 'LW_RAIL_OCT2',
            rail3live  : 'LW_RAIL3_LIVE',
            railProd   : prodTable,
    ]
    // Run in the order asked for, not in a fixed one: the whole point of a
    // variant list is to be able to put the slow baseline last and read the
    // cheap numbers without waiting for it.
    for (String name : variants.split(',').collect { it.trim() }.findAll { it }) {
        if (name == 'road') {
            run('road') {
                new Noise_level_from_traffic().exec(connection,
                        base + [tableRoads: 'ROADS'], new EmptyProgressVisitor())
            }
        } else if (railTables.containsKey(name)) {
            run(name) {
                new Noise_level_from_source().exec(connection,
                        base + [tableSources: railTables[name]], new EmptyProgressVisitor())
            }
        } else {
            throw new IllegalArgumentException("неизвестный вариант: ${name}" as String)
        }
    }

    // ---- the road + rail sum ------------------------------------------------
    // Also through the pipeline's own code. The join is column by column and by
    // name, so it silently assumes both passes came out in the same eight
    // octaves — the assumption that was false while the rail pass ran in third
    // octaves, and the reason it is worth exercising here rather than only in a
    // job that needs OSM and a quarter of an hour.
    if (sql.rows("""SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
                    WHERE TABLE_SCHEMA = 'PUBLIC'
                      AND TABLE_NAME IN ('LVL_ROAD', 'LVL_RAILPROD')""").size() == 2) {
        sql.execute('DROP TABLE IF EXISTS ROAD_LEVEL')
        sql.execute('DROP TABLE IF EXISTS RAIL_LEVEL')
        sql.execute('CREATE TABLE ROAD_LEVEL AS SELECT * FROM LVL_ROAD')
        sql.execute('CREATE TABLE RAIL_LEVEL AS SELECT * FROM LVL_RAILPROD')
        pipeline.invokeMethod('combineRoadRail', [sql] as Object[])
        def check = sql.firstRow("""
            SELECT MAX(ABS(c.LAEQ - 10 * LOG10(POWER(10, r.LAEQ / 10) + POWER(10, t.LAEQ / 10)))) AS worst,
                   MIN(c.LAEQ - GREATEST(r.LAEQ, t.LAEQ)) AS quietest,
                   AVG(c.LAEQ) AS mean
            FROM RECEIVERS_LEVEL c
            JOIN LVL_ROAD r ON r.IDRECEIVER = c.IDRECEIVER AND r.PERIOD = c.PERIOD
            JOIN LVL_RAILPROD t ON t.IDRECEIVER = c.IDRECEIVER AND t.PERIOD = c.PERIOD""")
        say(String.format('combine: LAEQ avg %.2f, off the energetic sum by %.4f dB at worst, ' +
                'and never less than %.4f dB above the louder of the two',
                (check.mean ?: 0) as double, (check.worst ?: 0) as double, (check.quietest ?: 0) as double))
    }

    // ---- what the shortcuts cost in decibels -------------------------------
    def tables = sql.rows("""SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
                             WHERE TABLE_SCHEMA = 'PUBLIC' AND TABLE_NAME LIKE 'LVL\\_%'""")
                   .collect { it.TABLE_NAME }
    if ('LVL_RAIL3' in tables) {
        for (String other : tables) {
            if (other == 'LVL_RAIL3' || other == 'LVL_ROAD') continue
            def d = sql.firstRow("""SELECT AVG(b.LAEQ - a.LAEQ) AS mean,
                                           MAX(ABS(b.LAEQ - a.LAEQ)) AS worst,
                                           COUNT(*) AS n
                                    FROM LVL_RAIL3 a JOIN ${other} b
                                      ON a.IDRECEIVER = b.IDRECEIVER AND a.PERIOD = b.PERIOD""" as String)
            say(String.format('%-12s vs rail3: mean %+.3f dB, worst %.3f dB, %d receivers',
                    other.substring(4).toLowerCase(), (d.mean ?: 0) as double,
                    (d.worst ?: 0) as double, d.n as int))
        }
    }

    return report.toString()
}
