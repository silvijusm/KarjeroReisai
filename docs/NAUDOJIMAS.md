# KarjeroReisai – kaip naudotis

- **Programėlė (Android):** https://github.com/silvijusm/KarjeroReisai/releases/download/testas/KarjeroReisai-testas.apk
- **Dispečerio centras (kompiuteris / naršyklė):** https://karjieroreisai.web.app

## Vežėjo įmonė (viršininkas)
1. Užsiregistruokite programėlėje: **Registruotis → Įmonė**.
2. **Vairuotojai** → gausite įmonės kodą `KR-…` → nusiųskite vairuotojams.
3. Vairuotojas: **Registruotis → Vairuotojas**, įveda kodą → jūs spaudžiate **Patvirtinti**.
4. **Automobiliai** → suveskite numerius (po vieną eilutėje) → **QR lipdukai (PDF)** → atspausdinkite ir priklijuokite ant priekinio stiklo.
5. **Žemėlapis** – visos mašinos gyvai (telefone ir https://karjieroreisai.web.app).
6. **Objektai** → įveskite rangovo duotą kodą `OB-…` → kai rangovas patvirtins, vairuotojai galės pasirinkti objektą.

## Vairuotojas
1. Pradėdamas darbą pasirenka **automobilį** ir (jei dirba rangovui) **objektą**.
2. **Pradėti darbą** – vieta siunčiama tik kol darbas vyksta.
3. Kai ekskavatorininkas pažymi „Pakrauta“ – ateina pranešimas → **Patvirtinti** arba **Neatitinka** (su komentaru).
4. **Baigti darbą** – mašina dingsta iš žemėlapio.

## Rangovas (objektas: kelias, statybvietė)
1. https://karjieroreisai.web.app → **Objektai → + Naujas objektas**.
2. Užpildykite: siuntėjas, gavėjas, karjeras ir iškrovimo vieta (paspauskite žemėlapyje), **sutartas atstumas km**, medžiagos su **tonomis reisui** ir tankiu, jei reikia – kitos tonos konkrečiai mašinai (`ABC123 = 20`).
3. **Sukurti kodą** → `OB-…` duokite vežėjams → skirtukas **Vežėjai** → **Patvirtinti**.
4. Ekskavatorininkas: užsiregistruoja kaip vairuotojas su **jūsų** įmonės kodu `KR-…` → **Vairuotojai → Keisti rolę → Krovėjas**.
5. **Pakrovimai**: suvestinė pagal vežėją / mašiną / medžiagą, **Excel**, **Važtaraščiai (PDF)**. Tonas ir km galite pataisyti (**Keisti**) – kiekvienas pakeitimas išsaugomas istorijoje.

## Ekskavatorininkas (krovėjas)
1. Programėlė atsidaro krovimo ekrane.
2. **📷 SKENUOTI QR** (arba paspausti mašiną iš sąrašo „Mašinos prie karjero“, arba įvesti numerį ranka).
3. Didelis žalias **PAKRAUTA** – tonos įrašomos pagal rangovo nustatymus. Veikia ir be ryšio.
4. Klaidą galima atšaukti per 15 min.

## Svarbu
- Važtaraščio teisinę galią (ar gali pakeisti popierinį) patvirtinkite su rangovo buhalterija / buhalteriu. Pradžioje naudokite šalia popierinio.
- Serverio dalies įdiegimas: GitHub → Actions → **Deploy Firebase** → Run workflow.
