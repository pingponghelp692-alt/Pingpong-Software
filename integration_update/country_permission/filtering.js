/* ==========================================================================
   Country Permission — Filtering
   ==========================================================================
   Generic helpers for narrowing dashboard/list data down to what the
   requesting admin is allowed to see, based on req.countryScope (set by
   middleware.attachCountryFilter). Kept generic/data-shape-agnostic so
   the Merchant and Call Hosting dashboards built later can reuse it
   instead of each writing their own country filter.
   ========================================================================== */

// list: array of arbitrary objects. countryKeyFn: (item) => countryId,
// defaults to item.countryId. If req.countryScope is null (global actor),
// returns the list unchanged.
function filterByCountry(list, req, countryKeyFn) {
    const getCountryId = countryKeyFn || ((item) => item.countryId);
    if (!req || req.countryScope === null || req.countryScope === undefined) return list;
    return (list || []).filter((item) => getCountryId(item) === req.countryScope);
}

// Parameterized SQL WHERE-fragment builder for the Postgres tables this
// module (and later modules) define — e.g.
//   const { clause, params } = scopeSqlWhere(req, "country_id", []);
//   client.query(`SELECT * FROM merchants WHERE 1=1 ${clause}`, params);
// Returns clause: "" for a global actor, " AND <column> = $N" otherwise,
// appending the bound value to whatever params array is passed in.
function scopeSqlWhere(req, column, params) {
    params = params || [];
    if (!req || req.countryScope === null || req.countryScope === undefined) {
        return { clause: "", params };
    }
    params.push(req.countryScope);
    return { clause: ` AND ${column} = $${params.length}`, params };
}

module.exports = { filterByCountry, scopeSqlWhere };
