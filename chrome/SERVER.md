# Сервер для расширения: HTTPS-прокси

Chrome не умеет VLESS/Reality: расширение работает только с HTTP/HTTPS-прокси. Нужен отдельный вход с логином и паролем. Chrome не поддерживает логин и пароль для SOCKS5, поэтому берём HTTPS-прокси (шифруется и сам канал до прокси).

## Вариант: дополнительный inbound в Xray (профиль конфигурации Remnawave)
Нужен домен, который смотрит на ноду, и TLS-сертификат для него (например, Let's Encrypt). Пути к сертификату поправьте под свою ноду.

```json
{
  "tag": "chrome-https",
  "listen": "0.0.0.0",
  "port": 8443,
  "protocol": "http",
  "settings": { "accounts": [{ "user": "free", "pass": "ПРИДУМАЙТЕ_ПАРОЛЬ" }], "allowTransparent": false },
  "streamSettings": {
    "network": "tcp",
    "security": "tls",
    "tlsSettings": { "alpn": ["http/1.1"], "certificates": [{ "certificateFile": "/path/fullchain.pem", "keyFile": "/path/privkey.pem" }] }
  }
}
```

Рекомендуется ограничить бесплатный доступ правилом маршрутизации, например, пускать только 80 и 443 и блокировать торренты:

```json
{ "type": "field", "inboundTag": ["chrome-https"], "port": "1-79,81-442,444-65535", "outboundTag": "block" },
{ "type": "field", "inboundTag": ["chrome-https"], "protocol": ["bittorrent"], "outboundTag": "block" }
```

Откройте порт 8443/tcp в файрволе ноды. Проверка: `curl -x https://free:ПАРОЛЬ@ВАШ.ДОМЕН:8443 https://ifconfig.me`: должен вернуться IP ноды.

## Список серверов для расширения
Файл `chrome/servers.json` в этом репозитории: расширение подтягивает его само, так что менять серверы и пароли можно без новой проверки в магазине:

```json
{ "version": 1, "servers": [
  { "id": "fi", "name": "Finland", "code": "FI", "scheme": "https", "host": "ВАШ.ДОМЕН", "port": 8443, "username": "free", "password": "ПАРОЛЬ" }
]}
```
Логин и пароль бесплатного доступа лежат в расширении и в открытом файле, то есть они по определению публичные: выдавайте им отдельный ограниченный аккаунт и не используйте пароль от платных сервисов.
