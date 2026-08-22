/* ==========================================================================
   PingPong — Country / Language catalogue
   ==========================================================================
   Single source of truth for the "First Time Profile Setup" country +
   language pickers (client fetches this via GET /api/meta/countries so the
   dropdown list and the server-side validation can never drift apart).

   Each country carries a real ISO-3166-1 alpha-2 `id` (used to render the
   flag and stored on the user as `user.country`) PLUS an `rbacRegion` —
   the *existing* 5-bucket admin scoping value from rbac.js
   (IN / BD / PK / AR / OTHERS) that user.countryId already used before this
   feature existed. New users now get their real country stored in
   `user.country` (so the correct flag shows on their ID everywhere), while
   `user.countryId` keeps getting auto-derived from it so every existing
   admin-panel country-scoping/RBAC rule keeps working unchanged.
   ========================================================================== */

// Regional-indicator flag emoji, computed from the ISO code — this is why a
// Nepali user gets 🇳🇵, a Saudi user gets 🇸🇦, etc. instead of everyone
// being hardcoded to the same one or two flags.
function flagEmoji(code) {
    if (!code || code.length !== 2) return "🏳️";
    return code.toUpperCase().replace(/./g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0)));
}

const COUNTRIES = [
    { id: "BD", name_bn: "Bangladesh", name_en: "Bangladesh", rbacRegion: "BD",
        languages: [{ code: "bn", name: "বাংলা" }, { code: "en", name: "English" }] },
    { id: "IN", name_bn: "India", name_en: "India", rbacRegion: "IN",
        languages: [
            { code: "bn", name: "বাংলা" }, { code: "hi", name: "हिन्दी" }, { code: "en", name: "English" },
            { code: "ta", name: "தமிழ்" }, { code: "te", name: "తెలుగు" }, { code: "ml", name: "മലയാളം" },
            { code: "kn", name: "ಕನ್ನಡ" }, { code: "mr", name: "मराठी" }, { code: "pa", name: "ਪੰਜਾਬੀ" },
            { code: "gu", name: "ગુજરાતી" }, { code: "or", name: "ଓଡ଼ିଆ" }
        ] },
    { id: "PK", name_bn: "Pakistan", name_en: "Pakistan", rbacRegion: "PK",
        languages: [{ code: "ur", name: "اردو" }, { code: "en", name: "English" }, { code: "pa", name: "ਪੰਜਾਬੀ" }] },
    { id: "NP", name_bn: "Nepal", name_en: "Nepal", rbacRegion: "OTHERS",
        languages: [{ code: "ne", name: "नेपाली" }, { code: "en", name: "English" }, { code: "hi", name: "हिन्दी" }] },
    { id: "LK", name_bn: "Sri Lanka", name_en: "Sri Lanka", rbacRegion: "OTHERS",
        languages: [{ code: "si", name: "සිංහල" }, { code: "ta", name: "தமிழ்" }, { code: "en", name: "English" }] },
    { id: "SA", name_bn: "Saudi Arabia", name_en: "Saudi Arabia", rbacRegion: "AR",
        languages: [{ code: "ar", name: "العربية" }, { code: "en", name: "English" }, { code: "bn", name: "বাংলা" }, { code: "ur", name: "اردو" }, { code: "hi", name: "हिन्दी" }] },
    { id: "AE", name_bn: "UAE", name_en: "UAE", rbacRegion: "AR",
        languages: [{ code: "ar", name: "العربية" }, { code: "en", name: "English" }, { code: "bn", name: "বাংলা" }, { code: "ur", name: "اردو" }, { code: "hi", name: "हिन्दी" }] },
    { id: "QA", name_bn: "Qatar", name_en: "Qatar", rbacRegion: "AR",
        languages: [{ code: "ar", name: "العربية" }, { code: "en", name: "English" }, { code: "bn", name: "বাংলা" }] },
    { id: "KW", name_bn: "Kuwait", name_en: "Kuwait", rbacRegion: "AR",
        languages: [{ code: "ar", name: "العربية" }, { code: "en", name: "English" }, { code: "bn", name: "বাংলা" }] },
    { id: "BH", name_bn: "Bahrain", name_en: "Bahrain", rbacRegion: "AR",
        languages: [{ code: "ar", name: "العربية" }, { code: "en", name: "English" }, { code: "bn", name: "বাংলা" }] },
    { id: "OM", name_bn: "Oman", name_en: "Oman", rbacRegion: "AR",
        languages: [{ code: "ar", name: "العربية" }, { code: "en", name: "English" }, { code: "bn", name: "বাংলা" }] },
    { id: "MY", name_bn: "Malaysia", name_en: "Malaysia", rbacRegion: "OTHERS",
        languages: [{ code: "ms", name: "Bahasa Melayu" }, { code: "en", name: "English" }, { code: "ta", name: "தமிழ்" }, { code: "bn", name: "বাংলা" }] },
    { id: "SG", name_bn: "Singapore", name_en: "Singapore", rbacRegion: "OTHERS",
        languages: [{ code: "en", name: "English" }, { code: "ms", name: "Bahasa Melayu" }, { code: "ta", name: "தமிழ்" }] },
    { id: "US", name_bn: "USA", name_en: "USA", rbacRegion: "OTHERS",
        languages: [{ code: "en", name: "English" }, { code: "bn", name: "বাংলা" }] },
    { id: "GB", name_bn: "UK", name_en: "UK", rbacRegion: "OTHERS",
        languages: [{ code: "en", name: "English" }, { code: "bn", name: "বাংলা" }] },
    { id: "CA", name_bn: "Canada", name_en: "Canada", rbacRegion: "OTHERS",
        languages: [{ code: "en", name: "English" }, { code: "bn", name: "বাংলা" }] },
    { id: "AU", name_bn: "Australia", name_en: "Australia", rbacRegion: "OTHERS",
        languages: [{ code: "en", name: "English" }] },
    { id: "OTHERS", name_bn: "Other", name_en: "Other", rbacRegion: "OTHERS",
        languages: [{ code: "en", name: "English" }, { code: "bn", name: "বাংলা" }] }
];

const COUNTRY_CODES = COUNTRIES.map((c) => c.id);
const COUNTRY_BY_ID = {};
COUNTRIES.forEach((c) => { COUNTRY_BY_ID[c.id] = c; });

// user.country ("BD","SA",...) -> the existing 5-bucket RBAC region
// (IN/BD/PK/AR/OTHERS) that admin-panel scoping already understands.
function regionForCountry(countryId) {
    const c = COUNTRY_BY_ID[countryId];
    return c ? c.rbacRegion : "OTHERS";
}

// Client-facing payload (adds the rendered flag, doesn't leak anything else)
function publicCountries() {
    return COUNTRIES.map((c) => ({
        id: c.id, name_bn: c.name_bn, name_en: c.name_en, flag: flagEmoji(c.id), languages: c.languages
    }));
}

module.exports = { COUNTRIES, COUNTRY_CODES, COUNTRY_BY_ID, flagEmoji, regionForCountry, publicCountries };
