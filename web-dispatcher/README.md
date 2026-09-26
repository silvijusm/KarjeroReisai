# KarjeroReisai web dispečerio centras

Šis katalogas yra Firebase Hosting web klientas įmonės administratoriui ir dispečeriui.

## Įgyvendinta

- Firebase Auth prisijungimas tuo pačiu el. paštu ir slaptažodžiu kaip Android programėlėje.
- Prieiga tik `company_admin`, `dispatcher` ir `super_admin`.
- Leaflet + OpenStreetMap gyvas žemėlapis iš `companies/{companyId}/liveLocations`.
- Vairuotojų sąrašas, patvirtinimas / atmetimas / rolės keitimas per Cloud Functions.
- Automobilių sąrašas ir pridėjimas per `saveCompanyVehicle`.
- Dienos sesijų suvestinė bei CSV eksportas.
- Stripe Billing Portal per `createBillingPortal`.
- LT, EN, RU, LV, ET, PL kalbos.
- Slaptų Firebase ar Stripe raktų kode nėra. Firebase klientas inicializuojamas per Firebase Hosting `/__/firebase/init.js`.

## Priklausomybės

Web centras sąmoningai kuriamas ant ankstesnių įmonės/rolių ir sinchronizavimo etapų. Kol `liveLocations` Firestore taisyklės bei Android gyvos vietos siuntimas dar neįdiegti, žemėlapis rodo informacinę būseną, o likusios dalys gali veikti su jau esančiais duomenimis.

## Paleidimas

Deploy:
```bash
firebase deploy --only hosting
```

Vietiniam testui naudokite Firebase Hosting emulatorių, nes `__/firebase/init.js` yra Firebase Hosting rezervuotas kelias.

## Saugumas

Web klientas pats nepriskiria vartotojui rolės ar įmonės. Jautrūs pakeitimai vykdomi tik per serverio Cloud Functions, o Firestore Security Rules išlieka galutinis autorizacijos sluoksnis.
