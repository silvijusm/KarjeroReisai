# Įmonės ir dispečerio funkcijos: pirmas pakeitimų etapas

## Patikrinta esamame kode

Bazinė versija: `873d2b8` (`main`). Tai pirmas serverio pagrindo PR pagal
`KarjeroReisai-uzduotis-imones-dispeceris.md.2.md`, o ne visos užduoties užbaigimas.

- Registracija kuria įmonę ir jos savininką viena Firestore operacija.
- Telefono reisai ir GPS saugomi `SQLiteOpenHelper` duomenų bazėje, **ne Room**.
  Duomenų bazė kol kas bendra telefone; prieš atveriant vairuotojo darbo ekranus
  būtina atskirti vietinius duomenis pagal paskyrą ir įmonę.
- Android `AuthViewModel` priima tik `company_admin` ir `super_admin`.
- Esamas Stripe kodas naudoja vieną kainą ir kiekį 1; serverio mokėjimai išjungti
  pagal numatytąją `BILLING_ENABLED` reikšmę. Tikroji debesies konfigūracija
  šiame PR netikrinta ir nekeista.
- Nėra debesų reisų sinchronizavimo ar žiniatinklio dispečerio centro.

## Kas įgyvendinta šiame PR

`functions/company.js` ir šešios autentifikuotos callable funkcijos regione
`europe-west1`:

| Funkcija | Įvestis | Rezultatas |
|---|---|---|
| `registerDriver` | `name` | Sukuria vairuotojo profilį be įmonės. El. paštas imamas iš Auth žetono. |
| `rotateCompanyCode` | `companyId` | Grąžina naują `companyCode`; senasis nebegalioja. |
| `requestCompanyMembership` | `code` | Sukuria laukiančią narystę; grąžina `companyId`, `status`. |
| `cancelCompanyRequest` | nėra | Atšaukia dar nepatvirtintą prašymą. |
| `reviewCompanyMembership` | `companyId`, `uid`, `action`, pasirinktinai `role` | Patvirtina / atmeta / pašalina narį arba keičia aktyvaus nario rolę. |
| `saveCompanyVehicle` | `companyId`, `plateNumber`, pasirinktinai `name`, `make`, `payloadT`, `active` | Įrašo automobilį; grąžina `vehicleId`. |

`action`: `approve`, `reject`, `remove`, `set_role`. `role`: `driver` arba
`dispatcher`; skiriama tik su `set_role`. Patvirtintas naujas narys visada yra
vairuotojas. Komandos ir automobilių valdymas leidžiamas tik patikrintam įmonės
savininkui arba esamam serverio administratoriui. Dispečeris gali skaityti
įmonės narių bei automobilių sąrašus, bet negali jų keisti.

Vairuotojo `users/{uid}` dokumente naudojami `membershipStatus` ir, tik kol
laukiama patvirtinimo, `pendingCompanyId`. `companyId` užpildomas tik patvirtinus.
Vienas vairuotojas vienu metu gali turėti vieną prašymą arba vieną aktyvią įmonę.
Esamų įmonių savininkų paskyros automatiškai nekeičiamos į vairuotojų paskyras.

Kodas turi 8 atsitiktinius simbolius po `KR-`; nenaudojami `0`, `O`, `1`, `I`.
Vienam UID leidžiama iki 10 bandymų per slenkantį valandos langą. Skaičiuojami
ir neteisingi kodai. Kodo keitimas, prašymai ir narystės pakeitimai atliekami
transakcijomis. Automobilio ID yra normalizuotas numeris, todėl pakartotinis
to paties numerio pridėjimas nesukuria dublikato. Numerio keitimas šiame etape
reiškia kitą automobilio ID; seną automobilį reikia išjungti.

Firestore taisyklės leidžia tik būtinas skaitymo operacijas. Narys, kurio
statusas neaktyvus, gali skaityti tik savo narystės statusą. Profilio rolė ir
įmonė turi sutapti su aktyvios narystės įrašu; vien suklastoto profilio neužtenka.
Narystės, kodai, bandymų ribos ir automobilių pakeitimai valdomi tik serveryje.
Pašalinimas nekeičia ir netrina ankstesnių darbo sesijų ar reisų.

## Patikra

Reikia Node.js 22 ir Java 21 ar naujesnės versijos Firestore emuliatoriui.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm ci --prefix functions --ignore-scripts --no-audit --no-fund
npm run test:rules
npm --prefix functions run check
npm --prefix functions test
python3 scripts/check-translations.py
python3 scripts/check-app-config.py
```

`test:rules` vykdo ir prieigos taisyklių testus, ir tikras Admin SDK transakcijas
vietiniame `demo-karjeroreisai` emuliatoriuje. Tikrinamos lygiagrečios kodo
keitimo, prisijungimo, patvirtinimo ir bandymų ribojimo operacijos. Be emuliatoriaus
integracinė testų grupė praleidžiama; vien `functions test` jos neatstoja.
Esamų mokėjimų testai palikti. Naujo vartotojo sąsajos teksto šiame PR nėra.

## Kas dar neįgyvendinta ir kitas etapas

Tai serverio pagrindas: įdiegtame APK naujų ekranų dar nėra. Vien šio PR
sujungimas neišleidžia naujos programėlės ir neįdiegia Firebase funkcijų.
Firebase diegimas šiame etape neatliekamas; senas APK vairuotojo profilio dar
nepriima, todėl naujomis funkcijomis nereikia pradėti registruoti tikrų vairuotojų.

Toliau būtina kartu įgyvendinti:

1. Android vairuotojo registraciją, laukimo / atmetimo ekranus, profilio
   atnaujinimą realiu laiku ir įmonės valdymo ekranus visomis šešiomis kalbomis.
2. Vietinių darbo duomenų atskyrimą pagal paskyrą; atskirą esamų duomenų perkėlimo
   kelią, nepriskiriant senų reisų atsitiktinai prisijungusiam vairuotojui.
3. Patvarų siuntimo eilės mechanizmą sesijoms, reisams ir maršrutų paketams;
   saugias Firestore taisykles ir konfliktų testus. Šiame PR sesijų ir GPS
   kolekcijų prieiga specialiai dar neatverta.
4. Automobilio pasirinkimą, užimtumo kontrolę ir naujos narystės pranešimus.
5. Gyvą žemėlapį, web centrą, ataskaitas ir kitus dokumento etapus atskirais PR.

Mokėjimų etape dar reikės suderinti dokumento prieštaravimą: I dalyje mokestis
skaičiuojamas vairuotojui, II dalies lentelėje – automobiliui. Bandomojo laikotarpio
keitimui iš 60 į 14 dienų dokumente aiškiai prašoma savininko sprendimo. Šiame
PR nei mokestis, nei bandomasis laikotarpis nekeičiami. Stripe quantity
sinchronizavimas bus atskirame mokėjimų etape; naujos narystės jo dar nekeičia.

Rangovo kilometrai ir tonos ateities atsiskaitymo duomenyse turi viršenybę prieš
GPS atstumą pagal užduoties 19 skyrių. Šiame etape atsiskaitymų skaičiai nekeisti.
