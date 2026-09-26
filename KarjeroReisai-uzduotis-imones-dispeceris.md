# KarjeroReisai – užduotis: įmonės, vairuotojai, dispečerio centras ir mokėjimai

> **Kam skirta:** Claude Code ar kitam programuotojui, dirbančiam repozitorijoje `github.com/silvijusm/KarjeroReisai`.
> **Savininkas:** Silvijus Meškėnas, S. Meškėno įmonė (info.karjeroreisai@gmail.com).
> Savininkas dirba ne programuotojas – aiškink paprastai, lietuviškai, o sudėtingus sprendimus priimk pats pagal šį dokumentą.

---

## 0. Darbo taisyklės (privaloma perskaityti pirmiausia)

1. **Pirmiausia ištirk esamą kodą.** Repozitorijoje jau yra: Android programėlė (Kotlin, `app/`), Firebase (Firestore, `firestore.rules`, Cloud Functions), Stripe Checkout + Billing Portal per autentifikuotas Firebase funkcijas, webhook'ų apdorojimas, įmonės administratoriaus skydelis, prieigos ribojimas pagal bandomąjį laikotarpį / apmokėtą planą, 6 kalbos (LT, EN, RU, LV, ET, PL), GPS darbo sesijos, PDF ataskaitos, CI (GitHub Actions: APK build, Firestore taisyklių testai, billing testai, vertimų patikra). **Nieko to nesugadink** – plėsk, o ne perrašyk.
2. Prieš keisdamas parašyk savininkui trumpą planą: ką radai, ką keisi, ko trūksta.
3. Dirbk **atskiroje šakoje** ir kurk **Pull Request** kiekvienam etapui (žr. 11 skyrių). Visi esami CI testai turi praeiti.
4. **Jokių slaptų raktų kode.** Stripe raktai, webhook secret – tik Firebase Functions secrets / GitHub Actions secrets.
5. Pirmiausia viskas veikia su **Stripe sandbox**. Tikri (live) raktai įjungiami tik savininkui patvirtinus.
6. Visi nauji tekstai – visomis 6 kalbomis (esama vertimų sistema).
7. Jei kažkas šiame dokumente prieštarauja esamam kodui – rinkis saugesnį variantą ir pranešk savininkui.

---

## 0.1 Esama būklė (patikrinta 2026-09-25, `main` šaka)

- **Reisai ir darbo sesijos saugomi TIK telefone** (Room, `app/.../data/AppDatabase.kt`). Į Firestore niekas nesiunčiama → viršininkas šiuo metu nieko negali matyti. **Pirmas būtinas darbas – debesų sinchronizacija** (sesijos, reisai, maršrutai) į `companies/{companyId}/...`, su veikimu be ryšio.
- **Vairuotojo rolės nėra.** Registruojantis visada kuriama nauja įmonė ir `company_admin` (`AuthViewModel.kt`, `firestore.rules` → `users` create leidžia tik `company_admin`). Reikia pridėti `driver` / `dispatcher` ir prisijungimą prie esamos įmonės per Cloud Function (klientas pats negali priskirti sau įmonės).
- `firestore.rules`: yra tik `users` ir `companies`. Viskas kita draudžiama – naujoms kolekcijoms reikės taisyklių + testų `tests/firestore.rules.test.mjs`.
- `companies` laukai: `name, ownerUid, plan, trialEndsAtMillis, createdAt`; bandomasis laikotarpis taisyklėse **60 d.** (5 184 000 000 ms).
- Mokėjimai (`functions/index.js`, `billing.js`): regionas `europe-west1`, vienas `STRIPE_PRICE_ID` parametras, `BILLING_ENABLED` numatyta `false`. Reikia palaikyti kelias kainas (lookup_key) ir įmonės `quantity`.
- Firebase projektas: `karjieroreisai` (žr. `docs/OWNER-SETUP.md`). `firebase.json` neturi `hosting` – web dispečeriui pridėti.
- ~~Šakniniame kataloge keisti failai~~ – 2026-09-26 patikrinta: jų nebėra, nieko daryti nereikia.
- `index.html` šaknyje = viešoji svetainė (GitHub Pages iš `main`/root). Aplanke `site/` yra `privacy.html`, `terms.html`, `delete-account.html` – svetainėje turi būti nuorodos į juos.

---

## 1. Tikslas

Įmonė (nuo 3 iki neriboto skaičiaus automobilių, realiai 5–40+) naudoja KarjeroReisai:

- **Vairuotojas** telefone registruoja savo darbą (darbo sesija, reisai, pakrovimas/iškrovimas, svoris, GPS maršrutas) ir **mato tik savo** duomenis.
- **Viršininkas / dispečeris** mato **visus įmonės automobilius gyvame žemėlapyje**, kiek reisų / km / tonų padarė kiekvienas vairuotojas ir automobilis, maršrutų istoriją ir ataskaitas.
- Viršininkas stebi **ir telefone** (ta pati Android programėlė), **ir kompiuteryje** (naršyklėje, be diegimo).
- Įmonė moka **3 € / vairuotojui / mėn.** (min. 3), mokestis automatiškai keičiasi pridėjus ar pašalinus vairuotoją.

---

## 2. Rolės ir teisės

| Rolė | Kas tai | Mato | Gali |
|---|---|---|---|
| `super_admin` | Savininkas (Silvijus) | Viską, visas įmones | Viską; esama teisė – nekeisti |
| `company_admin` | Įmonės viršininkas | Visus savo įmonės vairuotojus, automobilius, žemėlapį, ataskaitas | Tvirtinti/šalinti vairuotojus, valdyti automobilius, keisti įmonės kodą, skirti dispečerius, valdyti mokėjimą |
| `dispatcher` | Įmonės dispečeris | Tą patį kaip `company_admin` | Stebėti ir eksportuoti ataskaitas; **negali** keisti mokėjimo, šalinti admin |
| `driver` | Įmonės vairuotojas | **Tik savo** sesijas, reisus, ataskaitas | Pradėti/baigti darbą, registruoti reisus, pasirinkti automobilį |
| `individual` | Vienas vairuotojas be įmonės (esamas mėnesio/metinis planas) | Tik savo | Kaip dabar |

**Saugumas:** teisės tikrinamos **serveryje** (Firestore taisyklės + Cloud Functions), ne tik programėlėje. Vairuotojas negali perskaityti kito vairuotojo duomenų net tiesiogiai per Firestore API. Rolės saugomos Firebase Auth custom claims arba serverio valdomame dokumente, kurio klientas negali keisti.

---

## 3. Duomenų modelis (Firestore)

Prisitaikyk prie esamos struktūros; žemiau – reikalingi laukai.

```
companies/{companyId}
  name, vatCode?, companyCode, createdAt
  ownerUid
  billing: { stripeCustomerId, stripeSubscriptionId, status, seatsPaid, trialEndsAt }
  settings: { locationIntervalMovingSec: 60, locationIntervalStoppedSec: 300, dataRetentionDays: 365 }

companies/{companyId}/members/{uid}
  role: company_admin | dispatcher | driver
  status: pending | active | removed
  displayName, phone?, joinedAt, approvedBy, removedAt?

companies/{companyId}/vehicles/{vehicleId}
  plateNumber, name?, active

companies/{companyId}/liveLocations/{uid}        ← VIENAS dokumentas vairuotojui, perrašomas
  lat, lng, speedKmh, heading, accuracyM, updatedAt
  sessionId, vehicleId, state: moving | stopped | loading | unloading | offline

companies/{companyId}/sessions/{sessionId}      ← darbo sesijos (galbūt jau yra – pritaikyk)
  driverUid, vehicleId, startedAt, endedAt, km, tripsCount, tonnes
  routePoints: saugoti SUSPAUSTAI (pvz. polyline eilutė dalimis / subkolekcija po 500 taškų),
               ne po vieną dokumentą kiekvienam GPS taškui

companies/{companyId}/sessions/{sessionId}/trips/{tripId}
  loadPlace, unloadPlace, material, weightT, loadedAt, unloadedAt, km

companyCodes/{companyCode}  → { companyId }     ← greitai paieškai prisijungiant
```

---

## 4. Vairuotojo prisijungimas prie įmonės (įmonės kodas + patvirtinimas)

1. `company_admin` skydelyje mato **įmonės kodą**, pvz. `KR-4827` (atsitiktinis, lengvai padiktuojamas, be painių simbolių 0/O, 1/I). Mygtukai: „Kopijuoti“, „Dalintis“ (SMS/Viber), „Sugeneruoti naują kodą“ (senas nustoja galioti).
2. Vairuotojas programėlėje: susikuria paskyrą → „Prisijungti prie įmonės“ → įveda kodą.
3. Serveris (Cloud Function) patikrina kodą ir sukuria `members/{uid}` su `status: pending`. Vairuotojas mato: „Laukiama viršininko patvirtinimo“.
4. Viršininkui – pranešimas (push + ženkliukas skydelyje): „Jonas Jonaitis nori prisijungti“. Mygtukai **Patvirtinti / Atmesti**.
5. Patvirtinus – `status: active`, vairuotojas iškart gali dirbti įmonės vardu.
6. **Apsauga:** kodo bandymų riba (pvz. 10 per valandą vienam vartotojui); vienas vartotojas – viena aktyvi įmonė.
7. **Pašalinimas:** viršininkas pašalina vairuotoją → `status: removed`; vairuotojas nebemato įmonės duomenų, bet **jo senieji reisai lieka įmonės ataskaitose**.

---

## 5. Automobiliai

- `company_admin` suveda automobilių sąrašą (valstybinis numeris, pavadinimas). Galimas masinis įvedimas (vienas numeris eilutėje).
- Pradėdamas darbo sesiją vairuotojas **pasirenka automobilį** (atsimenamas paskutinis). Taip ataskaitos būna ir pagal vairuotoją, ir pagal automobilį, net jei vairuotojai keičiasi mašinomis.
- Vienas automobilis vienu metu – tik vienoje aktyvioje sesijoje (įspėjimas, jei jau užimtas).

---

## 6. Gyva vieta (live tracking) – pigiai ir taupiai

- Vieta siunčiama **tik kai darbo sesija aktyvi**. Baigus darbą – `state: offline`, siuntimas sustoja.
- Važiuojant – kas **60 s** (nustatoma `settings`), stovint – kas **300 s**; nesiųsti, jei pasislinko < 30 m ir praėjo < 5 min.
- Rašoma į **vieną** `liveLocations/{uid}` dokumentą (perrašoma), o ne naujas dokumentas kiekvieną kartą.
- Maršruto istorija kaupiama telefone ir įrašoma **paketais** (pvz. kas 5 min arba kas 100 taškų) į sesiją.
- Veikia su esama Android foreground service / GPS logika (pritaikyti, nekurti antros). Laikytis Android fono vietos leidimų reikalavimų ir akumuliatoriaus taupymo.
- Nėra ryšio → taškai kaupiami telefone ir išsiunčiami atsiradus ryšiui.

**Kaštų orientyras:** 40 automobilių × 10 val. × 1 įrašas/min ≈ 24 000 įrašų/dieną vienai įmonei → keli eurai per mėnesį Firebase (Blaze plane). Tai turi likti pigu – nedaryti dažnesnių įrašų be priežasties.

---

## 7. Dispečerio centras

### 7.1 Telefone (Android programėlė)
Prisijungus kaip `company_admin` / `dispatcher` rodomas dispečerio režimas (su galimybe perjungti į vairuotojo režimą, jei viršininkas pats vairuoja):
- **Žemėlapis** su visais aktyviais automobiliais: žymeklis = valst. numeris + vairuotojo vardas, spalva pagal būseną (važiuoja / stovi / krauna / iškrauna / neaktyvus > 10 min).
- **Sąrašas** po žemėlapiu: vairuotojas, automobilis, būsena, šiandien reisų/km/t, paskutinis atnaujinimas.
- Paspaudus vairuotoją – šiandienos maršrutas žemėlapyje ir reisų sąrašas.

### 7.2 Kompiuteryje (naršyklėje)
- Atskira **web programėlė** tame pačiame Firebase projekte, talpinama **Firebase Hosting** (nemokamas planas pakanka). Adresas pvz. `https://<projektas>.web.app`.
- Prisijungimas tuo pačiu Firebase Auth el. paštu ir slaptažodžiu. Įleidžiami tik `company_admin`, `dispatcher`, `super_admin`.
- Paprasta, greita technologija (pvz. Vite + TypeScript arba React). Žemėlapis – **Leaflet + OpenStreetMap** (nemokama, be API rakto) arba Google Maps, jei jau naudojamas programėlėje.
- Ekranai:
  1. **Žemėlapis** per visą ekraną + šoninis sąrašas su paieška ir filtrais (būsena, automobilis). Turi sklandžiai veikti su **40+ automobilių** (žymeklių grupavimas priartinus/nutolinus).
  2. **Vairuotojai**: sąrašas, laukiantys patvirtinimo, patvirtinti/atmesti/pašalinti, rolės (dispečeris).
  3. **Automobiliai**: pridėti/redaguoti/išjungti.
  4. **Ataskaitos**: laikotarpis (diena/savaitė/mėnuo/pasirinktas), grupavimas pagal vairuotoją arba automobilį; reisai, km, tonos, darbo valandos; **eksportas į PDF ir Excel (CSV/XLSX)**.
  5. **Istorija**: pasirinktos dienos maršrutas žemėlapyje su reisų taškais.
  6. **Mokėjimas**: dabartinis planas, vairuotojų skaičius, kitas mokėjimas, mygtukas į Stripe Billing Portal (kortelės keitimas, sąskaitos, atšaukimas).
  7. **Įmonės nustatymai**: pavadinimas, PVM kodas, įmonės kodas, duomenų saugojimo laikas.
- 6 kalbos, kaip ir programėlėje.
- Duomenys atsinaujina realiu laiku (Firestore listeners), bet klausytis **tik** `liveLocations` kolekcijos, ne visų sesijų.

---

## 8. Mokėjimai (Stripe)

### 8.1 Kainos (jau sukurtos Stripe **sandbox** aplinkoje, produktas „KarjeroReisai prenumerata“ `prod_VIOv3TyMXxYF6X`)

| Planas | Kaina (su PVM) | lookup_key | Sandbox price ID |
|---|---|---|---|
| Individualus mėnesio | 5 € / mėn. | `karjeroreisai_monthly` | `price_1UJfZELQCFL9AwCaKQIZSpH1` |
| Individualus metinis | 55 € / metus | `karjeroreisai_yearly` | `price_1UJfZVLQCFL9AwCajxKBFLlv` |
| Įmonėms | 3 € / vairuotojui / mėn., min. 3 | `karjeroreisai_company_per_driver` | `price_1UJfZbLQCFL9AwCaIaCee6kn` |

- Kode naudoti **lookup_key**, ne price ID – tada perėjus į live nereikės keisti kodo.
- Sena kaina 9,99 €/mėn. (`price_1UHo7HLQCFL9AwCap6OEUDwd`) – nebenaudoti; jei kodas ją naudoja, pakeisti į `karjeroreisai_monthly`.
- Visos kainos `tax_behavior: inclusive`.

### 8.2 Įmonės prenumerata pagal vairuotojų skaičių
- Įmonės prenumeratos `quantity` = aktyvių vairuotojų skaičius, bet ne mažiau kaip 3.
- Patvirtinus vairuotoją → Cloud Function padidina `quantity` (Stripe proration: `create_prorations`). Pašalinus → sumažina (ne mažiau 3).
- Jei įmonė dar nemoka (bandomasis laikotarpis) – `quantity` atnaujinamas tame pačiame trial subscription.

### 8.3 Bandomasis laikotarpis – ⚠️ SAVININKAS TURI PATVIRTINTI
- Programėlėje dabar **60 dienų** įmonėms, svetainėje parašyta **14 dienų**. Reikia **vienos** reikšmės visur.
- Numatyta: **14 dienų** (kaip svetainėje), bet **paklausk savininko prieš keisdamas** ir padaryk tai vienu konfigūracijos parametru.

### 8.4 Kur klientas moka
- Pagrindinis kelias: **programėlėje / web skydelyje** per esamą Stripe Checkout funkciją (serveris žino, kuri įmonė moka → automatiškai atrakina).
- Svetainėje (`index.html` GitHub Pages) dabar yra Stripe **Payment Links** (test). Jie klientą apmokestina, bet **neatrakina programėlės automatiškai**. Siūlymas: svetainės mygtukus pakeisti į „Atsisiųsti programėlę ir pradėti nemokamai“, arba webhook'e susieti Payment Link pirkimą su vartotoju pagal el. paštą. Suderink su savininku.

### 8.5 Webhook
- Sandbox aplinkoje webhook endpoint **dar nesukurtas**. Po Functions įdiegimo sukurti endpoint į esamą webhook funkciją su įvykiais: `checkout.session.completed`, `customer.subscription.created/updated/deleted`, `invoice.paid`, `invoice.payment_failed`. Secret – į Functions secrets.
- Nepavykęs mokėjimas → 7 dienų malonės laikotarpis, tada naujų darbų pradėti negalima (esami baigiami), kaip jau numatyta esamoje logikoje.

---

## 9. Duomenų apsauga (BDAR / GDPR)

- Vieta renkama **tik aktyvios darbo sesijos metu**; vairuotojas aiškiai mato, kad sesija aktyvi ir vieta siunčiama (nuolatinis pranešimas).
- Pirmą kartą prisijungus prie įmonės – ekranas su informacija: kas renkama (vieta darbo metu, reisai), kas mato (įmonės administracija), kiek saugoma, kam skambinti klausimais. Vairuotojas patvirtina „Susipažinau“ (įrašyti datą).
- `dataRetentionDays` (numatyta 365): senesni GPS taškai automatiškai trinami suplanuota funkcija; reisų suvestinės (be tikslių taškų) gali likti ataskaitoms.
- Vairuotojas gali atsisiųsti savo duomenis (eksportas).
- Pastaba savininkui: teisinius tekstus (privatumo politika, informavimas darbuotojams) turi peržiūrėti teisininkas.

---

## 10. Kokybė ir priėmimo kriterijai

- [ ] Vairuotojas su kodu prisijungia → laukia → viršininkas patvirtina → vairuotojas dirba įmonės vardu.
- [ ] Vairuotojas **negali** perskaityti kito vairuotojo sesijų (Firestore taisyklių testas).
- [ ] Pašalintas vairuotojas nebemato įmonės duomenų; jo seni reisai lieka ataskaitose.
- [ ] Dispečerio žemėlapyje (telefone ir naršyklėje) matosi visi aktyvūs automobiliai, atsinaujina ≤ 60 s.
- [ ] Web skydelis sklandžiai veikia su 40 imituotų automobilių (testinis generatorius).
- [ ] Ataskaita pagal vairuotoją ir pagal automobilį sutampa su sesijų duomenimis; PDF ir Excel eksportas veikia.
- [ ] Patvirtinus 4-ą vairuotoją Stripe `quantity` = 4; pašalinus iki 2 → `quantity` = 3.
- [ ] Mokėjimas sandbox kortele `4242 4242 4242 4242` atrakina įmonę per webhook.
- [ ] Neaktyvi sesija = jokio vietos siuntimo.
- [ ] Visi nauji tekstai 6 kalbomis; esami CI testai + nauji testai praeina.
- [ ] Nėra slaptų raktų kode.

---

## 11. Etapai (kiekvienas – atskiras Pull Request)

1. **Tyrimas ir planas** – aprašyk esamą struktūrą, kas jau yra iš šio dokumento, kas trūksta. Palauk savininko „gerai“.
2. **Rolės, įmonės kodas, vairuotojų patvirtinimas, automobiliai** + Firestore taisyklės ir testai.
3. **Gyva vieta** (taupus siuntimas) + dispečerio režimas Android programėlėje.
4. **Web dispečerio centras** (Firebase Hosting): žemėlapis, vairuotojai, automobiliai.
5. **Ataskaitos** ir eksportas (web + telefonas).
6. **Mokėjimai**: lookup_key, `quantity` sinchronizavimas, bandomasis laikotarpis (po savininko sprendimo), webhook sandbox.
7. **BDAR**: informavimo ekranas, duomenų trynimas, eksportas.
8. **Paleidimas**: naujas APK per esamą release workflow, Firebase deploy (functions, rules, hosting), instrukcija savininkui kaip pereiti į Stripe live.

Po kiekvieno etapo savininkui – trumpa santrauka lietuviškai: kas padaryta, kaip išbandyti telefonu, ką jam reikia paspausti (jei reikia).

---

## 12. Ko reikės iš savininko

- Patvirtinti bandomojo laikotarpio trukmę (14 ar 60 d.).
- Firebase projekte įjungti **Blaze** planą (Cloud Functions reikalauja; mažam naudojimui kaina ~0–kelių eurų).
- Stripe: aktyvuoti live paskyrą (įmonės duomenys, banko sąskaita, tapatybė), kai testai sėkmingi.
- Peržiūrėti privatumo / darbuotojų informavimo tekstus su teisininku.

---

# II DALIS – Rangovai, objektai, krovėjai ir elektroninis važtaraštis

> Savininko idėja (jis pats dirba vežėju karjeruose). Dabar karjere ekskavatorininkas ant popieriaus rašo, ką pakrovė, o vairuotojas ryte gauna popierinį **krovinio važtaraštį**, vakare jį užpildo ranka ir atiduoda. Tikslas – visa tai padaryti programėlėje, kad niekas nepildytų ranka ir visi matytų tuos pačius skaičius.

## 13. Paskyrų tipai (papildo 2 skyrių)

| Tipas | Kas | Moka |
|---|---|---|
| Asmeninis vairuotojas | Vienas vairuotojas | 5 €/mėn. arba 55 €/metus |
| Vežėjo įmonė | Savi automobiliai ir vairuotojai (I dalis) | 3 €/vairuotojui/mėn., min. 3 (savininkas patvirtino 2026-09-26) |
| **Rangovas** | Įmonė, vykdanti objektą (kelias, statybvietė) ir samdanti vežėjus vežti žvyrą, smėlį, skaldą | Siūloma ~20–30 €/objektui/mėn. (**kainą patvirtina savininkas**) |
| **Krovėjas (ekskavatorininkas)** | Karjere kraunantis darbuotojas, priskirtas rangovui arba karjerui | Nemokamai |
| Objekto priėmėjas | Rangovo darbuotojas objekte, priimantis krovinį | Nemokamai (rangovo narys) |

Vienas žmogus / įmonė gali turėti kelias roles (pvz. vežėjas, kuris dirba keliems rangovams).

## 14. Objektas

`contractors/{contractorId}/objects/{objectId}`:
- pavadinimas, **objekto kodas** (pvz. `P-256` – rangovo vidinis kodas, rodomas važtaraštyje), prisijungimo kodas vežėjams (pvz. `OB-7315`), būsena (aktyvus / baigtas);
- **siuntėjas** ir **gavėjas** (įmonės pavadinimas, adresas, įmonės kodas, PVM kodas) – užpildoma vieną kartą;
- **karjeras(-ai)** ir **iškrovimo vieta(-os)** – taškai + zonos (poligonai) žemėlapyje;
- medžiagos: pavadinimas + **piltinis tankis t/m³** (pvz. smėlis 1,6), kad būtų galima perskaičiuoti tonas ↔ kubus;
- atstumas karjeras–objektas (km, apskaičiuojamas iš maršruto arba įvedamas);
- prijungti vežėjai ir jų automobiliai.

**Vežėjo prijungimas:** rangovas duoda prisijungimo kodą → vežėjo įmonė jį įveda ir pažymi automobilius → rangovas patvirtina. Ta pati logika kaip 4 skyriuje.

**Privatumas (privaloma):** rangovas mato vežėjo automobilio vietą ir duomenis **tik tada, kai tas automobilis dirba jo objekte** (aktyvi sesija, priskirta šiam objektui). Kitų vežėjo darbų – nemato. Tikrinama Firestore taisyklėse.

## 15. Pakrovimo registravimas karjere (vietoj popieriaus)

1. Programėlė kiekvienam automobiliui sugeneruoja **QR kodą** (PDF lipdukas spausdinimui: QR + valst. Nr.). Vairuotojas jį užsiklijuoja ant priekinio stiklo.
2. Krovėjas telefonu **nuskenuoja QR** (arba pasirenka iš sąrašo automobilių, kurie pagal GPS yra karjero zonoje) → pasirenka medžiagą → įveda kiekį (**tonos** arba **m³** arba **kaušai**; perskaičiuojama pagal tankį) → „Pakrauta“. Tikslas: ≤ 5 s vienam reisui, dideli mygtukai, veikia su pirštinėmis.
3. Vairuotojui ateina pranešimas „Pakrauta: 26 t smėlio, 08:42“ → jis patvirtina (arba pažymi neatitikimą su komentaru).
4. Įvažiavus į objekto zoną GPS pats užfiksuoja **iškrovimą** (+ galimybė vairuotojui / priėmėjui patvirtinti rankiniu būdu).
5. Jei karjere yra **svarstyklės** – galima įvesti tikslų svorį ir nufotografuoti svėrimo lapelį (nuotrauka prisegama prie reiso).
6. **Be ryšio** – viskas kaupiama telefone ir sinchronizuojama atsiradus ryšiui; laikas imamas iš įvykio momento, ne sinchronizavimo.

## 16. Elektroninis krovinio važtaraštis

Pagal realų popierinį važtaraštį, kurį naudoja rangovas (pavyzdys: „Krovinio važtaraštis Nr. 0164549“). Programėlė jį **užpildo automatiškai**; žmogus tik patvirtina.

| Popieriaus laukas | Iš kur imama automatiškai |
|---|---|
| Važtaraščio Nr. | Rangovo numeracija (serija + eilės Nr.) arba įvedamas popierinio blanko Nr., kol rangovas pereina prie elektroninio |
| Siuntėjas / Gavėjas (pavadinimas, adresas, įmonės kodas, PVM kodas) | Objekto nustatymai |
| Data | Darbo sesijos data |
| Maršrutas (iš – į) | Objekto karjeras → iškrovimo vieta |
| Medžiaga, lyg. svoris (piltinis tankis) t/m³ | Objekto medžiaga |
| Įmonė vežėja + adresas | Vežėjo įmonės profilis |
| Pervežimus vykdo įmonė | Subrangovas vežėjas, jei vežėjas samdo kitą įmonę (neprivalomas laukas) |
| Mašinos markė, Valst. Nr., Transp. priem. keliamoji galia | Automobilio profilis (5 skyrius – papildyti laukais `make`, `payloadT`) |
| Atsakingo už pakrovimą asmens pavardė, parašas | Krovėjo paskyra + elektroninis patvirtinimas |
| Pirmo reiso pakrovimo pradžia / Paskutinio reiso pakrovimo pabaiga | Pirmo ir paskutinio pakrovimo įrašo laikas |
| Kraunama vienam reisui (t) / (m³) | Pakrovimo įrašai (jei skiriasi – rodyti kiekvieną reisą lentelėje) |
| Krovinį pervežimui priėmiau (pavardė, parašas) | Vairuotojo paskyra + patvirtinimas |
| Atvykimas į darbo vietą / Darbo pertrauka / Išvykimas iš darbo vietos | GPS: įvažiavimas / išvažiavimas iš objekto ar karjero zonos; pertrauka – stovėjimas > X min (nustatoma) arba vairuotojo pažymėta |
| Atstumas | Objekto atstumas arba GPS išmatuotas vieno reiso atstumas |
| Viso reisų / Viso tonų / Viso kubų | Susumuojama automatiškai |
| Objekto kodas | Objekto kodas (pvz. `P-256`) |
| Priėmusio asmens pareigos, pavardė, parašas | Objekto priėmėjo paskyra + patvirtinimas |
| ☐ „Jei atstumas didesnis negu 15 km, naudojamas tik vienam reisui“ | Taisyklė: jei atstumas > 15 km – **kiekvienam reisui atskiras važtaraštis**; kitaip – vienas važtaraštis dienai su visais reisais |

**Parašai:** patvirtinimas programėlėje (prisijungęs asmuo + laikas + telefono vieta), pasirinktinai – ranka pasirašyti ekrane pirštu. Kiekvienas patvirtinimas įrašomas ir nebekeičiamas (keitimai – tik nauja versija su istorija).

**PDF:** važtaraštis generuojamas PDF formatu, **išdėstymu kuo panašesnis į popierinį**, kad buhalterija ir rangovas jį atpažintų. Siunčiamas el. paštu rangovui ir vežėjui, prieinamas abiems skydeliuose.

**Svarbu savininkui:** ar elektroninis važtaraštis gali visiškai pakeisti popierinį, turi sutikti rangovas (jo buhalterija), o buhalterijos / VMI reikalavimus verta pasitikslinti su buhalteriu. Pradžioje programėlė gali veikti **šalia popieriaus** (įvedamas popierinio blanko Nr., PDF – kaip priedas), vėliau – vietoj jo.

## 17. Ataskaitos rangovui ir vežėjui

- Rangovui: pagal objektą, laikotarpį, vežėją, automobilį, medžiagą – reisai, tonos, kubai, važtaraščių sąrašas; eksportas PDF / Excel **atsiskaitymui su vežėjais**.
- Vežėjui: tie patys skaičiai jo pusėje – **sąskaitai rangovui išrašyti**. Abi pusės mato identiškus duomenis → nebelieka ginčų.
- Krovėjui: kiek pakrovė per dieną (pagal automobilį / medžiagą).

## 19. Rangovo nustatomi kilometrai ir tonos (SVARBU – turi pirmenybę prieš 15–16 skyrius)

Savininko reikalavimas: **atsiskaitymo kilometrus ir tonas nustato pats rangovas**, nes vežėjams mokama pagal sutartus dydžius, ne pagal GPS ar spėjimą.

**Kilometrai**
- Objekte rangovas įveda **sutartą atstumą** (pvz. 7 km) kiekvienam maršrutui karjeras → iškrovimo vieta. Jei karjerų ar iškrovimo vietų keli – atstumas kiekvienai porai atskirai.
- Važtaraštyje, ataskaitose ir atsiskaitymuose naudojamas **tik rangovo nustatytas atstumas**.
- GPS išmatuotas atstumas saugomas tik kaip informacija; jei jis nuo sutarto skiriasi daugiau nei nustatytą % (numatyta 20 %) – rangovui rodomas įspėjimas (ženkliukas prie reiso), bet skaičiai **nekeičiami automatiškai**.

**Tonos**
- Rangovas nustato **tonas vienam reisui**:
  - numatytąsias objektui / medžiagai (pvz. smėlis – 26 t), ir
  - galimybę nustatyti **kitaip konkrečiam automobiliui** (pvz. mažesnė mašina – 20 t).
- Tada krovėjui kiekio įvesti **nereikia**: nuskenuoja QR → „Pakrauta“ → įrašoma rangovo nustatyta tonų reikšmė. (Krovėjui palikti galimybę pažymėti „nepilnas“ / „kitas kiekis“ su komentaru, jei rangovas tai leidžia nustatymuose.)
- Kubai skaičiuojami iš tonų pagal rangovo nustatytą piltinį tankį.
- Jei yra svarstyklės – rangovas nustatymuose pasirenka, kas galioja: **nustatytos tonos** ar **svėrimo rezultatas**.

**Pakeitimai**
- Rangovas (ir tik jis / jo dispečeris) gali pakeisti km ar tonas **atgaline data** konkrečiam reisui ar laikotarpiui (pvz. pasikeitė maršrutas). Kiekvienas pakeitimas saugomas istorijoje: kas, kada, sena ir nauja reikšmė, priežastis.
- Pakeitimai po važtaraščio patvirtinimo kuria **naują važtaraščio versiją**; vežėjas gauna pranešimą ir mato, kas pakeista.
- Vežėjas ir vairuotojas **negali** keisti rangovo nustatytų km ir tonų – tik pažymėti nesutikimą su komentaru.

**Priėmimo kriterijai**
- [ ] Rangovas nustato 7 km ir 26 t → visi dienos reisai važtaraštyje ir ataskaitoje turi 7 km ir 26 t, net jei GPS rodo kitaip.
- [ ] Automobiliui nustatyta 20 t → to automobilio reisai skaičiuojami po 20 t.
- [ ] Krovėjas užregistruoja pakrovimą vienu mygtuko paspaudimu (be kiekio įvedimo).
- [ ] Vežėjas negali pakeisti km / tonų (taisyklių testas); rangovo pakeitimas matosi istorijoje.

## 18. Etapai (tęsinys po I dalies 8 etapo)

9. Rangovo paskyra, objektai, vežėjų prijungimas prie objekto, **rangovo nustatomi km ir tonos (19 sk.)** + privatumo taisyklės ir testai.
10. Karjero / objekto zonos, QR lipdukai, krovėjo ekranas, pakrovimo patvirtinimas, darbas be ryšio.
11. Elektroninis važtaraštis + PDF pagal popierinio išdėstymą + 15 km taisyklė.
12. Rangovo ir vežėjo ataskaitos, Stripe kaina rangovui (po savininko patvirtinimo).

**Priėmimo kriterijai:**
- [ ] Krovėjas nuskenuoja QR ir užregistruoja pakrovimą ≤ 5 s; veikia be ryšio.
- [ ] Rangovas nemato vežėjo automobilio, kai tas dirba kitur (taisyklių testas).
- [ ] Dienos pabaigoje važtaraštis užpildytas automatiškai; trūksta tik patvirtinimų.
- [ ] Atstumas > 15 km → kiekvienam reisui atskiras važtaraštis.
- [ ] PDF važtaraštis atitinka popierinio laukus ir išdėstymą.
- [ ] Rangovo ir vežėjo ataskaitų sumos sutampa.

---

# III DALIS – Papildomos funkcijos (savininkas patvirtino: visos)

> Diegti po I ir II dalių. Prioritetas nurodytas skliaustuose: **(A)** – pirmiausia, **(B)** – vėliau, **(C)** – kai liks laiko.

## 20. Darbo ir poilsio režimas (A)

- **Vairuotojo laikmatis**: vairavimas / kitas darbas / pertrauka / poilsis. Vairavimas nustatomas automatiškai pagal GPS greitį (> 5 km/h ilgiau nei 1 min), kita – vairuotojas perjungia vienu mygtuku.
- Skaičiuojama pagal ES reglamentą (EB) Nr. 561/2006 (parametrus laikyti konfigūracijoje, ne kode):
  - po 4,5 val. vairavimo – 45 min pertrauka (galima 15 + 30 min);
  - per dieną iki 9 val. vairavimo (du kartus per savaitę – iki 10 val.);
  - per savaitę iki 56 val., per dvi savaites iki 90 val.;
  - kasdienis poilsis – 11 val. (sutrumpintas 9 val. – iki 3 kartų tarp savaitinių poilsių).
- Įspėjimai vairuotojui: prieš 30 min ir prieš 10 min iki privalomos pertraukos / dienos limito (garsas + pranešimas, dideli skaitmenys ekrane).
- **Atskiras ekranas viršininkui / dispečeriui / rangovui** (atskira teisė, pvz. `can_view_driving_times`): kuriems vairuotojams artėja pertrauka ar limitas; savaitės / dviejų savaičių suvestinė.
- Funkcija yra **tik pagalbinė** – teisiškai pagrindinis yra tachografas. Savininko sprendimas: **pagrindiniame ekrane jokio papildomo įspėjamojo užrašo nerodyti**. Vienas sakinys („Pagalbinė informacija, teisiškai galioja tachografo duomenys“) – tik naudojimo sąlygose (`site/terms.html`) ir pagalbos / „Apie“ skiltyje.
- (B) Tachografo `.ddd` failų įkėlimas ir palyginimas (vėlesnis etapas; naudoti patikrintą atvirą biblioteką, jei tokia yra).

## 21. Vežėjams

1. **Sąskaita faktūra vienu mygtuku (A).** Iš pasirinkto laikotarpio patvirtintų važtaraščių sukuriama PVM sąskaita faktūra rangovui: pardavėjo ir pirkėjo rekvizitai (iš profilių), eilutės pagal objektą / medžiagą, kiekis (reisai / t / t·km), įkainis, PVM 21 %, suma. Serija ir numeracija – vežėjo nustatymuose. PDF + el. paštas. Pastaba: suderinti su buhalteriu; ateityje – eksportas buhalterinei programai / VMI i.SAF formatu.
2. **Įkainiai (A).** Kiekvienam objektui / rangovui: €/reisui, €/tonai arba €/t·km (km – rangovo nustatyti, 19 sk.). Rodoma: uždirbta per dieną / mėnesį / objektą. Įkainius gali nustatyti rangovas (sutarties kaina), vežėjas mato ir patvirtina.
3. **Kuras ir išlaidos (B).** Čekio nuotrauka + suma + litrai + automobilis; kitos išlaidos (remontas, padangos). Pelnas pagal objektą = pajamos – išlaidos. Vid. sąnaudos l/100 km pagal automobilį.
4. **Priminimai apie dokumentus ir techniką (A).** Automobiliui: techninė apžiūra, draudimas, tachografo kalibravimas, padangų / tepalų keitimas pagal km. Vairuotojui: vairuotojo pažymėjimas, kodas 95, tachografo kortelė, medicininė pažyma. Priminimai prieš 30 / 7 / 1 d. vairuotojui ir viršininkui; dokumento nuotrauka prisegama.

## 22. Rangovams

1. **Objekto eiga (A).** Planas (pvz. 5 000 t smėlio) → atvežta / liko / % / prognozė, kada baigsis (pagal pastarųjų dienų tempą). Pagal medžiagą.
2. **Atsiskaitymas su vežėjais (A).** Mėnesio suvestinė kiekvienam vežėjui su sumomis pagal įkainius; turi sutapti su vežėjo sąskaita (21.1). Neatitikimai paryškinami.
3. **„Reikia mašinų“ (B).** Rangovas skelbia užsakymą: data, laikas, karjeras → objektas, medžiaga, reikalingas mašinų skaičius, įkainis. Prijungti vežėjai gauna pranešimą ir atsako „Siunčiu N mašinų“. Rangovas mato, kiek patvirtinta. (Ateityje – galimybė skelbti ir neprijungtiems vežėjams – ryšys su savininko krovinių biržos projektu.)
4. **Iškrovimo nuotrauka (B).** Vairuotojas / priėmėjas nufotografuoja iškrovimą; nuotrauka prisegama prie reiso ir važtaraščio. Nuotraukos suspaudžiamos (≤ 300 KB), saugomos Firebase Storage, trinamos pagal `dataRetentionDays`.

## 23. Vairuotojams

1. **Kiek uždirbau šiandien (A).** Jei vairuotojui mokama pagal reisus / tonas – viršininkas nustato vairuotojo įkainį; vairuotojas mato savo dienos / mėnesio uždarbį (kitų – nemato).
2. **Eilė karjere (B).** Kiek automobilių dabar yra karjero zonoje ir laukia pakrovimo (pagal GPS ir dar neužregistruotus pakrovimus), apytikslis laukimo laikas.
3. **Navigacija (C).** Mygtukas „Vesti į karjerą / objektą“ – atidaro Google Maps / Waze su rangovo pažymėtu įvažiavimo tašku (sunkvežimių maršrutams nekurti savo navigacijos).
4. **Gedimo pranešimas (B).** Nuotrauka + trumpas aprašas + automobilis → pranešimas viršininkui; būsena: naujas / tvarkoma / sutvarkyta.

## 24. Ekskavatorininkui

- **Atvažiuojančių mašinų sąrašas (B):** automobiliai, važiuojantys į jo karjerą (pagal GPS kryptį ir aktyvų objektą), su apytiksliu atvykimo laiku; kitas eilėje – viršuje.

## 25. Etapai (tęsinys)

13. Darbo ir poilsio režimas + dispečerio ekranas (20 sk.).
14. Įkainiai, uždarbis, sąskaita faktūra, atsiskaitymas su vežėjais (21.1–21.2, 22.2, 23.1).
15. Priminimai apie dokumentus ir techniką (21.4).
16. Objekto eiga (22.1).
17. (B) Kuras ir išlaidos, „Reikia mašinų“, iškrovimo nuotraukos, eilė karjere, gedimų pranešimai, atvažiuojančių mašinų sąrašas.
18. (C) Navigacija, tachografo `.ddd` įkėlimas.

**Priėmimo kriterijai (pagrindiniai):**
- [ ] Po 4 val. vairavimo vairuotojas gauna įspėjimą; po 4,5 val. – aiškus „Privaloma pertrauka“.
- [ ] Viršininkas mato, kuriems vairuotojams per 1 val. baigsis leistinas vairavimas.
- [ ] Iš mėnesio važtaraščių sukuriama teisinga PVM sąskaita (sumos sutampa su rangovo suvestine).
- [ ] Priminimas apie techninę apžiūrą ateina prieš 30 d. vairuotojui ir viršininkui.
- [ ] Objekto eiga rodo teisingą atvežtų tonų sumą ir % nuo plano.
