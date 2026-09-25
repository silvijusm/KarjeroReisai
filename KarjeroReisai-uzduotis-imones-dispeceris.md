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
