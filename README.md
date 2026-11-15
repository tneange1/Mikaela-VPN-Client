<div align="center">

<img src="logo.png" width="96" alt="Mikaela VPN">

# Mikaela VPN

**Лёгкий и аккуратный VPN-клиент для Windows**
Вход по аккаунту из кабинета и бота · Xray-core + sing-box (TUN) · автообновление

[![Release](https://img.shields.io/github/v/release/tneange1/Mikaela-VPN-Client?style=flat-square&color=34c759)](https://github.com/tneange1/Mikaela-VPN-Client/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/tneange1/Mikaela-VPN-Client/total?style=flat-square&color=0a84ff)](https://github.com/tneange1/Mikaela-VPN-Client/releases)
![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-8e8e93?style=flat-square)

[**Скачать для Windows**](https://github.com/tneange1/Mikaela-VPN-Client/releases/latest/download/Mikaela-VPN.exe) · [Android](https://github.com/tneange1/Mikaela-VPN-Android/releases/latest/download/Mikaela-VPN.apk) · [Личный кабинет](https://cabinet.mikaelavpn.xyz) · [Telegram-бот](https://t.me/vpnmikaelabot)

</div>

---

## Возможности

| | |
|---|---|
| **Один аккаунт** | Тот же логин, что в [боте](https://t.me/vpnmikaelabot) и [кабинете](https://cabinet.mikaelavpn.xyz): почта и пароль, Telegram и другие способы входа, если они включены в кабинете |
| **Весь трафик через TUN** | Системный VPN на базе sing-box, прокси в настройках Windows не нужны |
| **Xray как есть** | Конфиг из Remnawave запускается в Xray-core без изменений: VLESS, Reality, Hysteria 2 и другое |
| **Серверы** | Флаги, протокол под названием, пинг справа (TCP и UDP для Hysteria), авто-выбор лучшего |
| **Несколько тарифов** | Если в боте несколько подписок, можно выбрать нужную |
| **Продление и баланс** | Пополнение, продление тарифа с баланса, докупка устройств: варианты и цены берутся из кабинета |
| **Устройства** | Просмотр и удаление привязанных устройств |
| **Маршрутизация** | Отдельные приложения и домены идут напрямую или только через VPN |
| **Kill Switch** | Если VPN оборвётся, интернет блокируется, пока вы не подключитесь снова |
| **Работа в фоне** | Закрытие окна сворачивает приложение в трей, VPN продолжает работать; выход через меню значка в трее |
| **Автозапуск** | Запуск вместе с Windows, свёрнутым, с автоподключением |
| **Автообновление** | Новая версия скачивается сама, на главном экране появляется кнопка «Обновить» |
| **Discord Rich Presence** | Необязательная активность в профиле |
| **Темы** | Как в системе, белая, серая, чёрная |

## Установка

1. Скачайте [`Mikaela-VPN.exe`](https://github.com/tneange1/Mikaela-VPN-Client/releases/latest/download/Mikaela-VPN.exe) (ссылка всегда ведёт на последнюю версию).
2. Запустите установщик. Приложению нужны права администратора: оно создаёт виртуальный сетевой адаптер.
3. Войдите в аккаунт, выберите сервер и нажмите кнопку питания.

> Windows SmartScreen может показать предупреждение: сборка пока не подписана сертификатом. Нажмите «Подробнее → Выполнить в любом случае».

## Как это работает

```
Приложение ──► TUN (sing-box) ──► SOCKS 127.0.0.1:10870 ──► Xray-core ──► сервер VPN
                    ▲                                           │
                    └── трафик самого Xray идёт мимо TUN ◄──────┘
```

- Подписка запрашивается с собственным User-Agent `MikaelaVPN/…`, поэтому в панели Remnawave для клиента можно настроить отдельное правило ответа.
- Адреса серверов определяются заранее и закрепляются, чтобы не зависеть от DNS при подключении.
- Перед включением TUN проверяется, что канал Xray действительно работает.
- Подписка кэшируется в зашифрованном виде: список серверов виден и без сети.

## Настройки

**Основное:** тема, частота автообновления списка серверов, версия приложения.

**Дополнительные настройки**
- *Автозапуск с Windows*: через планировщик задач с высшими правами, без запроса UAC при каждом входе.
- *Запускать свёрнутым* (сразу в трей) и *Автоподключение*.
- *Kill Switch*: блокирует исходящий трафик через брандмауэр Windows, если VPN неожиданно оборвался. Блокировка снимается при подключении, при ручном отключении, при выходе из приложения и при следующем запуске.
- *Показывать в Discord*.

**Маршрутизация**
- Режим: «всё через VPN, кроме списка» или «только список через VPN».
- *Приложения*: выбор из запущенных или файл `.exe` вручную.
- *Домены*: `example.com` включает и все поддомены.

Изменения маршрутизации применяются при следующем подключении (приложение предложит переподключиться).

## Сборка

Сборка идёт в GitHub Actions: workflow сам скачивает sing-box, Xray-core, wintun и базы geoip/geosite в папку `bin/`.

**Выпуск версии**
1. Закоммитьте изменения в `main`.
2. Releases → *Draft a new release* → создайте тег вида `v1.2.3` → *Publish*.
3. Actions соберёт установщик и прикрепит к релизу `Mikaela-VPN.exe` и `latest.yml`. Версия берётся из тега.
4. Установленные клиенты увидят релиз и предложат обновиться.

Обычный push в `main` только собирает файл для скачивания в артефактах.

**Локально (Windows)**
```bash
# положите в bin/: sing-box.exe, xray.exe, wintun.dll, geoip.dat, geosite.dat
npm install
npm start          # запуск без сборки
npm run dist       # установщик в dist/
```

## Конфигурация

| Переменная | Назначение |
|---|---|
| `MIKAELA_API` | Адрес API кабинета (по умолчанию `https://cabinet.mikaelavpn.xyz`) |
| `MIKAELA_DISCORD_ID` | Application ID для Discord Rich Presence |

Для Discord в [Developer Portal](https://discord.com/developers/applications) загрузите картинку в Rich Presence → Art Assets с ключом `logo`.

## Безопасность

- Токены входа хранятся зашифрованно средствами Windows (DPAPI).
- Запросы к кабинету и подписке идут только по HTTPS.
- Окно приложения изолировано от системы: интерфейс получает только разрешённый набор функций.
- Обновления проверяются по контрольной сумме из `latest.yml`. Для защиты от подмены включите двухфакторную защиту GitHub-аккаунта.
- В клиенте нет секретов: права доступа проверяются на стороне кабинета.

## Если что-то пошло не так

**Нет интернета после аварийного завершения при включённом Kill Switch.** Запустите приложение (оно снимает блокировку само) или выполните в PowerShell от администратора:
```powershell
Set-NetFirewallProfile -All -DefaultOutboundAction Allow
Get-NetFirewallRule -Group 'MikaelaVPN-KS' | Remove-NetFirewallRule
```

**Серверы не загружаются.** Проверьте, что подписка активна в [кабинете](https://cabinet.mikaelavpn.xyz), и нажмите «Обновить» на вкладке «Серверы».

**Не подключается.** Проверьте, что приложение запущено от администратора и что антивирус не блокирует `xray.exe` и `sing-box.exe`.

## Планы

- [x] Приложение для Android ([Mikaela-VPN-Android](https://github.com/tneange1/Mikaela-VPN-Android))
- [ ] Подпись сборки сертификатом

---

<div align="center">

Сделано для [Mikaela VPN](https://t.me/vpnmikaelabot)

</div>
