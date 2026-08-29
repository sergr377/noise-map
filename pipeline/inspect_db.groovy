/** Dumps table schemas from a job database — used to inspect what a
 *  NoiseModelling block actually produced, rather than guessing from docs. */
import groovy.sql.Sql
import org.h2gis.api.ProgressVisitor
import java.sql.Connection

title = 'Inspect database'
description = 'List columns of the tables named in NM_TABLES, or run NM_QUERY'
inputs = [:]
outputs = [result: [name: 'result', title: 'result', description: 'schema dump', type: String.class]]

def exec(Connection connection, Map input, ProgressVisitor progress) {
    Sql sql = new Sql(connection)
    StringBuilder out = new StringBuilder()

    // A schema dump answers "what columns are there" but not "what is actually in
    // them", and the questions that matter here — which row carries SRID 0, which
    // geometry came out empty — are the second kind. Read-only by convention, not
    // by enforcement: this runs against a job database nobody is serving from.
    String query = System.getenv('NM_QUERY')
    if (query) {
        out.append("=== NM_QUERY ===\n").append(query).append('\n')
        try {
            sql.eachRow(query) { row ->
                def meta = row.getMetaData()
                def cells = (1..meta.getColumnCount()).collect { i ->
                    "${meta.getColumnLabel(i)}=${row.getAt(i - 1)}"
                }
                out.append(cells.join('  ')).append('\n')
            }
        } catch (Exception e) {
            out.append('ERROR: ').append(e.message).append('\n')
        }
        return out.toString()
    }

    def wanted = (System.getenv('NM_TABLES') ?: 'LW_RAILWAY,RAIL_SECTIONS').split(',')

    sql.eachRow("SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA='PUBLIC' ORDER BY TABLE_NAME") { row ->
        out.append("TABLE ").append(row.TABLE_NAME).append('\n')
    }

    for (String table : wanted) {
        String name = table.trim().toUpperCase()
        out.append("\n=== ").append(name).append(" ===\n")
        try {
            def cols = []
            sql.eachRow("""SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS
                           WHERE TABLE_NAME = '${name}' ORDER BY ORDINAL_POSITION""" as String) { row ->
                cols << "${row.COLUMN_NAME}:${row.DATA_TYPE}"
            }
            out.append(cols.join(', ')).append('\n')
            def n = sql.firstRow("SELECT COUNT(*) AS n FROM ${name}" as String).n
            out.append("rows: ").append(n).append('\n')
        } catch (Exception e) {
            out.append('ERROR: ').append(e.message).append('\n')
        }
    }
    return out.toString()
}
