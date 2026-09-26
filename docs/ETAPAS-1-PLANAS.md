# 1 etapas – tyrimas ir planas

> Patikrinta 2026-09-26, `main` šaka (versija 0.7.1). Užduotis: `KarjeroReisai-uzduotis-imones-dispeceris.md`.
> Šiame etape kodas **nekeičiamas** – tik aprašoma, kas yra, ko trūksta ir kaip darysime.

## 1. Kas jau yra (ir veikia)

| Dalis | Kur | Pastaba |
|---|---|---|
| Android programėlė (Kotlin + Compose) | `app/` | Darbo sesija, reisai rankiniu ir automatiniu (GPS zonos A→B) būdu, istorija, maršruto žemėlapis, PDF ataskaita |
| Duomenys telefone | `data/AppDatabase.kt` | Paprasta SQLite (ne Room). Lentelės `work_sessions`, `trips`, `gps_points` |
| GPS | `location/LocationTrackingService.kt` | Foreground service, taškas kas ~5 s, viskas rašoma tik į telefoną |
| Žemėlapis | osmdroid (OpenStreetMap) | Nemokamas, be rakto → web pusėje naudosime Leaflet + OSM, kad būtų vienodai |
| Prisijungimas | Firebase Auth, `AuthViewModel.kt` | Registracija visada sukuria **naują įmonę + `company_admin`** |
| Firestore taisyklės | `firestore.rules` | Tik `users` ir `companies`; viskas kita uždrausta. 20 testų |
| Prieigos riba | `AppScreen.kt` | Naują darbą galima pradėti, jei `plan == paid` arba galioja bandomasis laikotarpis (60 d.) |
| Mokėjimai | `functions/billing.js`, `index.js` | Stripe Checkout, Billing Portal, webhook su užraktu ir dublikatų apsauga. Išjungta (`BILLING_ENABLED=false`). Viena kaina, `quantity: 1` |
| Savininko skydelis | `SettingsScreen.kt` → `AdminPanel` | `super_admin` mato įmonių sąrašą |
| 6 kalbos | `res/values*` | 107 tekstai, CI tikrina |
| CI | `.github/workflows` | APK build, taisyklių testai, billing testai, vertimai, pasirašytas release |

## 2. Ko trūksta pagal užduotį

1. **Debesų sinchronizacijos nėra.** Sesijos, reisai ir GPS lieka telefone – viršininkas nieko nemato. Tai pagrindas visam kitam.
2. **Nėra rolių `driver`, `dispatcher`**, nėra `members`, `vehicles`, `liveLocations`, `companyCodes` kolekcijų, nėra prisijungimo prie esamos įmonės.
3. **Nėra „individualaus“ plano.** Dabar vienas vairuotojas = įmonė su vienu žmogumi. Tai tinka – paliksime taip (individualus = įmonė be vairuotojų), tik skirsis kaina.
4. **Mokėjimai:** viena kaina (`STRIPE_PRICE_ID`), nėra `lookup_key`, nėra `quantity` pagal vairuotojų skaičių, webhook'as neapdoroja `invoice.paid` / `invoice.payment_failed`, nėra 7 d. malonės laikotarpio.
5. **Web dispečerio nėra**, `firebase.json` neturi `hosting`.
6. **BDAR ekranų, duomenų trynimo pagal laiką nėra.**

## 3. Neatitikimai, kuriuos radau

| # | Kas | Ką siūlau |
|---|---|---|
| A | Bandomasis laikotarpis: programėlėje ir taisyklėse **60 d.**, svetainėje **14 d.** | Reikia savininko sprendimo. Padarysiu vienu parametru |
| B | Užduoties 13 sk. buvo „3 €/automobiliui“ | Savininkas patvirtino: **už vairuotoją**. Dokumentas pataisytas |
| C | Veikianti svetainė yra **šakninis `index.html`** (tikrinta naršyklėje). Workflow `pages.yml` skelbia aplanką `site/`, bet jis dabar nenaudojamas | Palikti šakninį. Į jį įdėti nuorodas `site/privacy.html`, `site/terms.html`, `site/delete-account.html` (dabar jų nėra – Google Play jų reikalauja) |
| D | Svetainėje Stripe **Payment Links** (test) – apmokestina, bet programėlės neatrakina | Siūlau mygtukus pakeisti į „Atsisiųsti ir išbandyti nemokamai“, o mokėti programėlėje |
| E | Užduotyje minimi keisti failai šaknyje (`(AndroidManifest.xml` ir kt.) | Jų jau nebėra – nieko daryti nereikia |
| F | Užduotis sako „Room“ | Iš tikrųjų paprasta SQLite. Plėsime ją (nauja DB versija 4), neperrašysime |

## 4. Kaip darysime (patikslinta etapų tvarka)

Pagrindinis pakeitimas: **debesų sinchronizaciją** dedu į 3 etapą kartu su gyva vieta, nes be jos dispečeris neturi ką rodyti.

**2 etapas – rolės, įmonės kodas, vairuotojai, automobiliai**
- Nauja Cloud Function `joinCompany(code)`: tikrina kodą, riba 10 bandymų/val., sukuria `companies/{id}/members/{uid}` su `pending`.
- `approveMember`, `rejectMember`, `removeMember`, `regenerateCompanyCode` – tik `company_admin`.
- Rolė laikoma serverio valdomame `members` dokumente (klientas negali keisti). `users` profilis gaus rolę `driver` / `dispatcher` tik per funkciją.
- Registracijos ekrane nauja parinktis: „Esu vairuotojas – prisijungsiu prie įmonės“.
- `vehicles`: sąrašas, masinis įvedimas, pasirinkimas pradedant darbą.
- Firestore taisyklės + testai: vairuotojas mato tik save, pašalintas – nieko.
- Esama registracija (`company_admin`) ir visi 20 testų lieka nepakitę.

**3 etapas – sinchronizacija, gyva vieta, dispečeris telefone**
- Kiekviena sesija gauna ilgalaikį ID; pridedamas stulpelis `synced`. Foninė užduotis (WorkManager) siunčia sesijas, reisus ir maršrutą paketais (kas 5 min / 100 taškų), veikia be ryšio.
- Gyva vieta: vienas `liveLocations/{uid}` dokumentas, kas 60 s važiuojant, 300 s stovint. Esamas GPS servisas pritaikomas, antras nekuriamas. Telefone GPS tikslumas lieka toks pat (reisų skaičiavimui).
- Dispečerio režimas: žemėlapis (osmdroid) + sąrašas.

**4–8 etapai** – kaip užduotyje (web dispečeris, ataskaitos, mokėjimai, BDAR, paleidimas).

## 5. Kaštai

- Firebase **Blaze** planas reikalingas Cloud Functions (2 etapui). 40 automobilių įmonei – keli eurai per mėnesį. Siūlau Google Cloud nustatyti biudžeto įspėjimą (pvz. 10 €).
- Web dispečeris – Firebase Hosting, nemokamai.

## 6. Ko reikia iš savininko dabar

1. **Bandomasis laikotarpis: 14 ar 60 dienų?**
2. **Svetainės mygtukai:** pakeisti į „Atsisiųsti ir išbandyti“ (siūlau) ar palikti Stripe nuorodas?
3. **Firebase Blaze** – ar jau įjungtas? Jei ne – įjungti prieš 2 etapą (ir nustatyti biudžeto įspėjimą).
4. Pasakyti **„gerai“** 2 etapui.
