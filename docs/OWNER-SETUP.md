# Platformos savininko ir mokėjimų paleidimas

Šis failas skirtas tik projekto savininkui. Programėlėje nėra bendro administratoriaus slaptažodžio ar paslėpto PIN.

## 1. Savininko paskyra

1. Android programėlėje įprastai užregistruokite savininko el. paštą ir įmonę.
2. Patikimoje administravimo aplinkoje prisijunkite prie Firebase / Google Cloud projekto su Application Default Credentials arba tarnybine paskyra, kurios raktas **nėra** laikomas GitHub.
3. Iš katalogo `functions` pirmiausia atlikite sausą patikrą:

```sh
npm ci
npm run provision-admin -- --email SAVININKO_EL_PASTAS --project karjieroreisai
```

4. Įrankis turi parodyti teisingą UID ir įmonę. Tada pakartokite su `--apply`:

```sh
npm run provision-admin -- --email SAVININKO_EL_PASTAS --project karjieroreisai --apply
```

Įrankis atsisako suteikti teises, jei nurodyta paskyra nėra esamos įmonės savininkas. Po pakeitimo atsijunkite ir prisijunkite programėlėje iš naujo. Nustatymuose atsiras administratoriaus skiltis.

## 2. Stripe mokėjimai

Mokėjimai kode yra išjungti pagal nutylėjimą. Prieš įjungiant realius atsiskaitymus reikia:

- savo Stripe paskyros ir patvirtinto verslo;
- Stripe prenumeratos produkto bei `price_...` identifikatoriaus;
- viešo HTTPS grįžimo URL;
- Firebase Functions projekto su atsiskaitymu;
- Firebase secret `STRIPE_SECRET_KEY`;
- Firebase secret `STRIPE_WEBHOOK_SECRET`;
- parametrų `STRIPE_PRICE_ID`, `BILLING_RETURN_URL` ir `BILLING_ENABLED=true`;
- Stripe webhook nukreipto į paskelbtą `stripeWebhook` funkciją.

Pirmiausia viską patikrinkite Stripe test režime. Tik po sėkmingo pilno testinio pirkimo perjunkite į live raktus.

## 3. Ką mato savininkas

`super_admin` paskyrai Nustatymai → Administratorius rodo įmonių sąrašą ir nuorodą į Stripe Dashboard. Klientų `company_admin` paskyros mato tik savo prenumeratą ir mokėjimo / prenumeratos valdymo mygtukus.

Savininko paskyra nebekviečia kliento prenumeratos funkcijų, todėl atskira administratoriaus paskyra gali veikti ir be `companyId`.

## 4. Saugumo taisyklė

Niekada nedėkite Stripe secret, service-account privataus rakto ar administratoriaus privilegijų suteikimo rakto į Android APK, Git istoriją ar viešą GitHub Actions žurnalą.
