# Установка в Firebase кнопкой из GitHub

Кнопка: GitHub → **Actions** → **Deploy Firebase (rules + member functions)** → **Run workflow**.
Она устанавливает правила Firestore и 7 функций для водителей/компаний. Stripe (оплаты) не трогает.

## Один раз перед первым запуском

### 1. Тариф Blaze
console.firebase.google.com → проект **karjieroreisai** → слева внизу **Upgrade** → **Blaze**.
Сразу поставьте бюджетное предупреждение (например 10 €).

### 2. Ключ доступа (JSON)
1. Firebase → ⚙️ **Project settings** → вкладка **Service accounts** → **Generate new private key** → **Generate key**.
   Скачается файл `karjieroreisai-....json`.
2. Откройте console.cloud.google.com/iam-admin/iam?project=karjieroreisai
3. Найдите строку `firebase-adminsdk-...@karjieroreisai.iam.gserviceaccount.com` → карандаш ✏️ (Edit).
4. **Add another role** и добавьте 4 роли:
   - **Editor**
   - **Cloud Functions Admin**
   - **Cloud Run Admin**
   - **Service Account User**
5. **Save**.

### 3. Ключ в GitHub
1. github.com/silvijusm/KarjeroReisai → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**.
2. Name: `FIREBASE_SERVICE_ACCOUNT`
3. Secret: откройте скачанный JSON-файл Блокнотом, **выделите всё** (Ctrl+A), скопируйте и вставьте.
4. **Add secret**.
5. **Удалите JSON-файл с компьютера** (и из корзины). Этот ключ даёт полный доступ к проекту – никому не пересылайте.

## Запуск
GitHub → **Actions** → слева **Deploy Firebase (rules + member functions)** → справа **Run workflow** → зелёная кнопка **Run workflow**.
Первый раз 5–10 минут. Зелёная галочка = готово. Красный крестик – откройте запуск, скопируйте текст ошибки.

Если первый запуск упал с ошибкой про API / permissions / "service agent" – подождите 5 минут и запустите ещё раз
(Google включает сервисы с задержкой).
