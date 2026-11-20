# Карточка Chrome Web Store: Mikaela VPN

## Вкладка «Описание магазина»
**Категория:** Инструменты (Tools). **Язык по умолчанию:** English; добавьте перевод Русский.
**Цена:** бесплатно (в Chrome Web Store платных расширений больше нет).

### Краткое описание (до 132 символов)
- EN: Fast, free proxy VPN for your browser. One click, fastest server chosen automatically, no sign-up.
- RU: Быстрый бесплатный VPN для браузера: один клик, самый быстрый сервер выбирается сам, без регистрации.

### Подробное описание EN
Mikaela VPN protects your browsing with one click.

• One button: turn the VPN on and off instantly
• Auto mode picks the fastest server by real latency
• Or choose a country yourself and see the ping of every server
• Free to use, no account or sign-up needed
• Local addresses (your router, intranet) are never sent through the VPN

How it works: when you turn it on, the extension sets Chrome to use a Mikaela VPN proxy server. Turn it off and Chrome returns to normal. The extension does not collect your browsing history or page content. See the privacy policy for details.

Need your whole device protected? Mikaela VPN apps for Windows and Android route all traffic, with more servers and speed: https://cabinet.mikaelavpn.xyz

### Подробное описание RU
Mikaela VPN защищает ваш интернет в один клик.

• Одна кнопка: включайте и выключайте VPN мгновенно
• Автовыбор подбирает самый быстрый сервер по реальной задержке
• Или выберите страну сами и смотрите пинг каждого сервера
• Бесплатно, без аккаунта и регистрации
• Локальные адреса (роутер, внутренняя сеть) не идут через VPN

Как это работает: при включении расширение настраивает Chrome на прокси-сервер Mikaela VPN. При выключении Chrome возвращается к обычным настройкам. Расширение не собирает историю посещений и содержимое страниц. Подробности в политике конфиденциальности.

Нужен весь трафик устройства? Приложения Mikaela VPN для Windows и Android пропускают через VPN весь трафик, серверов и скорости больше: https://cabinet.mikaelavpn.xyz

### Графика
- Значок 128×128: `extension/icons/icon128.png` (уже внутри ZIP)
- Скриншоты 1280×800: `store/screenshot_en_1..3.png`, `store/screenshot_ru_1..3.png`
- Малая промо-плитка 440×280: `store/promo_small_en.png` / `_ru.png`
- Маркетинговая плитка 1400×560 (необязательно): `store/promo_marquee_en.png` / `_ru.png`

## Вкладка «Конфиденциальность»
**Единственное назначение (Single purpose):** Направлять трафик браузера через прокси-серверы Mikaela VPN, выбранные пользователем.

**Обоснование разрешений:**
- `proxy`: включает и выключает прокси Chrome, когда пользователь нажимает кнопку.
- `storage`: хранит выбранный сервер, состояние и кэш списка серверов.
- `webRequest` и `webRequestAuthProvider`: подставляют логин и пароль, когда сам прокси-сервер запрашивает авторизацию (событие onAuthRequired). Запросы страниц не читаются и не изменяются.
- Доступ к сайтам `<all_urls>`: прокси действует на все сайты, а запрос авторизации прокси может прийти при открытии любого сайта; также нужен для загрузки списка серверов и замера задержки до них.

**Удалённый код:** нет (загружается только JSON со списком серверов).

**Раскрытие данных (Data usage):** заполните по тому, что реально делают ваши серверы. Расширение само ничего не собирает. Если на серверах пишутся логи с адресами посещаемых сайтов, это нужно отметить («Web history»), и политика должна это отражать. Затем поставьте 3 галочки о соответствии политике «Limited Use».

**URL политики конфиденциальности:**
https://github.com/tneange1/Mikaela-VPN-Client/blob/main/chrome/PRIVACY.md

## Вкладка «Распространение»
Видимость: «Публичная» (или «Не в списке» для рекламных ссылок). Регионы: по вашему выбору.
