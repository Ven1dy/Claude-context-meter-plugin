<!-- Пак модов Claude Code: метр контекста, кэш и лимиты, handoff, защита от опасных команд и др. Установка одной командой. -->
<div align="center">

# 🧠 Claude Context Meter

**Пак модов для Claude Code: видно, сколько занято контекста, сколько осталось лимитов и что сотрёт опасная команда.**

Работает везде, где есть Claude Code: терминал · VS Code · Cursor · Claude Desktop

![Claude Code](https://img.shields.io/badge/Claude%20Code-mods-d97757?style=flat-square)
![Mods](https://img.shields.io/badge/модов-7-4ea1ff?style=flat-square)
![Platforms](https://img.shields.io/badge/Windows%20·%20macOS%20·%20Linux-3fb68b?style=flat-square)

</div>

---

## ⚡ Установка одной командой

**Windows** (PowerShell):

```powershell
irm https://raw.githubusercontent.com/Ven1dy/Claude-context-meter-plugin/main/install.ps1 | iex
```

**macOS / Linux / Git Bash**:

```bash
curl -fsSL https://raw.githubusercontent.com/Ven1dy/Claude-context-meter-plugin/main/install.sh | bash
```

Что делает установщик:

1. Находит Claude Code: в `PATH` или внутри расширения VS Code, Cursor или Windsurf. Если не находит, ставит его официальным установщиком.
2. Подключает этот репозиторий как маркетплейс плагинов.
3. Ставит все моды в пользовательскую область `~/.claude`. Терминал, VS Code и Desktop читают одну и ту же папку, поэтому моды появятся везде.
4. Переносит настройки старой установки. Если моды раньше были подключены папками через `CLAUDE_CODE_PLUGIN_DIRS` или хуком в `~/.claude/settings.json`, их параметры из `pluginConfigs` (например, `ttlMinutes=60`) передаются в новую установку, а старые записи убираются, чтобы моды не загружались дважды. Чужие записи и другие хуки установщик не трогает. Прежний файл остаётся рядом копией `settings.json.bak-*`.

После установки перезапустите Claude Code.

<details>
<summary><b>Другие способы установки</b></summary>

Внутри Claude Code (в терминальной сессии):

```text
/plugin marketplace add Ven1dy/Claude-context-meter-plugin
/plugin install context-meter@claude-context-meter-plugin
```

Из оболочки, по одному моду:

```bash
claude plugin install context-meter --marketplace Ven1dy/Claude-context-meter-plugin
```

В Claude Desktop, где `/plugin` недоступна: кнопка **+** рядом с полем ввода → **Plugins** → **Add marketplace** → `Ven1dy/Claude-context-meter-plugin` → **Add plugin**.

</details>

---

## 🧩 Что внутри

| Мод | Что делает | Команды |
|---|---|---|
| **context-meter** | Полоса над полем ввода: сколько процентов контекста занято и сколько добавило последнее сообщение. Открывает панель с разбивкой по категориям (как `/context`) и историей прироста по сообщениям. Пишет в чат строку «было → стало» после сжатия. При 30% показывает предупреждение и играет звук. Кнопки `/compact` и `/clear` | `/context-history` |
| **session-pulse** | Сколько ещё проживёт кэш промпта и сколько израсходовано лимитов (5 часов и неделя). Перед тем как кэш остынет, показывает кнопки «Подогреть», «Авто», «Сжать» и «Где мы» (короткий пересказ работы от Haiku) | — |
| **handoff** | Когда контекст разрастается до зоны, где модель начинает ошибаться, предлагает перенести работу в чистую сессию. Агент пишет handoff-документ, мод делает `/clear` и сам отправляет новому агенту «прочитай и продолжи» | `/handoff [сообщение]` |
| **blast-radius** | Перед `rm -rf`, `git reset --hard`, `git clean`, force push и миграциями показывает карточку: какие файлы и сколько мегабайт пропадут, какие коммиты потеряются. Кнопки «Выполнить», «Отложить» и «Отмена». Если не ответить, команда уходит в общую очередь | `/deletions` |
| **file-links** | Пути к файлам в ответах агента становятся кликабельными ссылками | — |
| **session-folder** | Показывает в подвале папку сессии и ветку git. Если агент перешёл через `cd` в другую папку, предупреждает | — |
| **compact-notify** | При запуске сжатия пишет строку в чат и показывает уведомление Windows, чтобы было видно, что `/compact` уже идёт. Только Windows | — |

## ⚙️ Настройка

Посмотреть параметры мода и изменить их:

```bash
claude plugin configure session-pulse
```

| Мод | Параметр | По умолчанию | Описание |
|---|---|---|---|
| session-pulse | `ttlMinutes` | `5` | Сколько минут живёт кэш. Если у аккаунта часовой кэш, поставьте `60` |
| handoff | `softTokens` / `firmTokens` / `lastTokens` | 350k / 600k / 800k | Пороги для больших окон (от 500k) |
| handoff | `softTokensSmall` / `firmTokensSmall` / `lastTokensSmall` | 100k / 150k / 170k | Пороги для окон до 500k |
| file-links | `linkStyle` | `percent` | `percent` или `angle`: как кодировать пробелы в ссылках |

Задать значение сразу при установке:

```bash
claude plugin install session-pulse@claude-context-meter-plugin --config ttlMinutes=60
```

## 🔄 Обновление и удаление

```bash
claude plugin marketplace update claude-context-meter-plugin   # подтянуть новые версии
claude plugin uninstall context-meter                          # удалить один мод
```

## 📝 Заметки

- Старое подключение модов папками установщик убирает сам (см. п. 4 выше). На macOS и Linux для этого нужен `python3`. Без него установщик только предупредит, и дубли придётся убрать из `settings.json` вручную.
- **blast-radius** на Windows ищет Git Bash в `C:/Program Files/Git/usr/bin`, поэтому нужен Git for Windows.
- **session-pulse** («Подогреть», «Где мы») и **handoff** отправляют настоящие запросы к модели и расходуют лимит.
- **blast-radius** основан на моде из `anthropics/claude-code-playground` (Apache-2.0). Лицензия лежит в [plugins/blast-radius/LICENSE](plugins/blast-radius/LICENSE).

## 📁 Структура

```text
.claude-plugin/marketplace.json   список модов для /plugin install
plugins/<мод>/                    каждый мод: .claude-plugin/plugin.json, hooks/, types/
install.ps1                       установщик для Windows
install.sh                        установщик для macOS, Linux и Git Bash
```
