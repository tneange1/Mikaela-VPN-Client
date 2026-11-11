# Mikaela VPN — клиент для Windows (sing-box)

Вход по email+паролю из кабинета/бота → подписка из Remnawave → sing-box.

## Сборка .exe
1. Залей папку в приватный GitHub-репозиторий.
2. Actions → build-windows → Run workflow. В артефактах будут установщик и portable .exe.
Локально (Windows): положи `sing-box.exe` и `wintun.dll` в `bin/`, затем `npm i && npm run dist`.
Запуск без сборки: `npm i && npm start`.

## Настройка
- API по умолчанию: https://cabinet.mikaelavpn.xyz (пробует корень и /api). Другой адрес: переменная MIKAELA_API.
- В Remnawave должен быть включён шаблон подписки sing-box (клиент запрашивает подписку с User-Agent sing-box).
- Версия sing-box меняется в .github/workflows/build.yml (SINGBOX_VERSION).
