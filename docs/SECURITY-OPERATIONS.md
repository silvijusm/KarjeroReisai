# Saugumo pakeitimų užbaigimas

Šaltinio kodo pakeitimas savaime nepaskelbia Firestore taisyklių ir nepakeičia Google API rakto.

## Taisyklės

Reikalavimai testams: Node.js 22, Java 21.

```sh
npm ci --ignore-scripts
npm run test:rules
```

Testai naudoja tik vietinį `demo-karjeroreisai` emuliatorių, ne gyvus duomenis.
Prieš diegimą iš Firebase Console išsaugoti dabartines paskelbtas taisykles ir palyginti
su šiuo failu: konsolėje gali būti papildomų taisyklių, kurių nėra Git.
Patikrinti esamus `super_admin` profilius ir įmonių `ownerUid`: jais pasitikima.
Dabartinė programėlė registruoja įmonės administratorių, todėl savininko prieiga
lieka palaikoma. Darbuotojų / vairuotojų kvietimams reikia atskiros patikimos narystės
schemos; savavališkas `companyId` nėra narystės įrodymas.

Prisijungus prie teisingos paskyros ir sėkmingai atlikus testus:

```sh
npx firebase deploy --only firestore:rules --project karjieroreisai
```

Taisyklės išlaiko Android naudojamą atominę įmonės ir profilio registraciją.
30 dienų bandymo pabaigai leidžiama iki 5 minučių telefono laikrodžio paklaida.
Plano, bandymo trukmės, savininko ir rolės keitimai atliekami tik patikimoje
serverio aplinkoje per Admin SDK. Android versija 0.7.0 neleidžia pradėti naujo
darbo, kai `company_admin` neturi aktyvaus `paid` plano ir 30 dienų bandomasis
laikotarpis jau pasibaigęs. Jau pradėtą darbą galima saugiai užbaigti.

## Google API raktas

Google Cloud projekte `karjieroreisai` sutikrinti perspėjimo raktą ir jo API
apribojimus. Firebase kliento raktas nėra tarnybinės paskyros privatus raktas.
Leisti tik reikalingas Firebase API; kitoms API naudoti atskirus apribotus raktus.
Patikrinti naudojimą, išlaidas, kvotas ir Authentication paskyras nuo aptikimo.

Jeigu raktas naudojamas piktavališkai, panaikinti jį nedelsiant.
Kitu atveju pakaitinį apribotą raktą pirmiausia išbandyti: registracija,
prisijungimas, slaptažodžio atkūrimas, Firestore skaitymas / įrašymas.
Atnaujinti naudojamus APK ir tik tada panaikinti senąjį. Raktų nerašyti į žurnalus.

Workflow jau palaiko GitHub Actions secret `GOOGLE_SERVICES_JSON` (visas JSON).
Kol šis secret nesukonfigūruotas ir nepatikrintas, naudojamas esamas kliento failas,
kad nesugriūtų APK kūrimas. Po pakeitimo patikros:

```sh
git rm --cached app/google-services.json
```

`.gitignore` apsaugo nuo naujo įtraukimo. APK vis tiek turės kliento konfigūraciją;
Actions Secrets nepakeičia API apribojimų, Security Rules ir App Check.

## GitHub nustatymai (reikia administravimo prieigos)

- Palikti secret scanning įjungtą ir įjungti push protection.
- Po pirmo sėkmingo paleidimo apsaugoti `main`: PR, sėkmingas `firestore-rules`
  patikrinimas, uždraustas šakos trynimas ir force-push.
- Vieno prižiūrėtojo projekte nereikalauti antro žmogaus patvirtinimo,
  jeigu nėra antro prižiūrėtojo: tai užblokuotų pataisų priėmimą.
- Actions numatytosios teisės: skaitymas; nereikalingų rašymo teisių nesuteikti.
- Šaltinio workflow turi minimalias teises, nesaugo checkout prisijungimo duomenų,
  veiksmai prisegti prie commit SHA, Dependabot prižiūri jų atnaujinimus.
- Perspėjimą žymėti `Revoked` tik patvirtinus, kad senas raktas panaikintas.
  Saugiai apribotam Firebase kliento raktui uždarymo priežastį dokumentuoti tik
  patikrinus realius apribojimus. Vien JSON failo pašalinimas incidento neužbaigia.

## Istorija

Raktą apriboti / panaikinti prieš istorijos perrašymą. Tinkamai apribotam Firebase
kliento raktui istorijos trinti nebūtina. Jei reikia pašalinti failą visiškai,
pirmiausia sustabdyti rašymą į repo, saugiai išsaugoti esamas nuorodas ir naujame
klone su git-filter-repo >= 2.47 vykdyti:

```sh
git-filter-repo --sensitive-data-removal --invert-paths --path app/google-services.json
```

Prieš force-push patikrinti visas paveiktas šakas, žymas ir PR. Neskelbti senos
istorijos atsarginės kopijos viešoje šakoje. Bendradarbiai turi klonuoti iš naujo;
kitų žmonių forkų ir senų APK šis veiksmas nepašalina. Jei yra tikrų paslapčių
žurnaluose / artefaktuose, pašalinti ir tas kopijas po įrodymų išsaugojimo.
