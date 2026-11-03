#!/usr/bin/env bash
# Установщик пака модов Claude Code: curl -fsSL https://raw.githubusercontent.com/Ven1dy/Claude-context-meter-plugin/main/install.sh | bash
# Ставит все моды в пользовательскую область (~/.claude): они работают в терминале, VS Code, Cursor и Claude Desktop.

main() {
  local repo='Ven1dy/Claude-context-meter-plugin'
  local market='claude-context-meter-plugin'
  local mods=(
    'context-meter|заполнение контекста над полем ввода, история по сообщениям'
    'session-pulse|кэш промпта и лимиты 5ч / неделя, подогрев кэша'
    'handoff|перенос работы в чистую сессию, /handoff'
    'blast-radius|карточка перед rm -rf, reset --hard, force push; /deletions'
    'file-links|кликабельные пути к файлам в ответах'
    'session-folder|папка сессии и ветка git в подвале'
  )
  # compact-notify шлёт уведомление Windows, на других системах ему нечего делать.
  case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) mods+=('compact-notify|уведомление Windows о запуске сжатия') ;; esac

  local settings="$HOME/.claude/settings.json"
  # Настоящий Python 3: на Windows python3 бывает заглушкой Microsoft Store.
  local py='' cand
  for cand in python3 python; do
    if "$cand" -c 'import sys; sys.exit(sys.version_info[0] < 3)' >/dev/null 2>&1; then py=$cand; break; fi
  done
  local is_windows=''
  case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) is_windows=1 ;; esac

  local c0=$'\033[0m' dim=$'\033[2m' red=$'\033[31m' green=$'\033[32m' yellow=$'\033[33m' blue=$'\033[34m' mag=$'\033[35m' cyan=$'\033[36m' bold=$'\033[1m'
  step() { printf '\n  %s>%s %s\n' "$cyan" "$c0" "$1"; }

  printf '\n'
  printf '%s   ██████╗ ██████╗ ███╗   ██╗████████╗███████╗██╗  ██╗████████╗%s\n' "$mag" "$c0"
  printf '%s  ██╔════╝██╔═══██╗████╗  ██║╚══██╔══╝██╔════╝╚██╗██╔╝╚══██╔══╝%s\n' "$mag" "$c0"
  printf '%s  ██║     ██║   ██║██╔██╗ ██║   ██║   █████╗   ╚███╔╝    ██║   %s\n' "$mag" "$c0"
  printf '%s  ██║     ██║   ██║██║╚██╗██║   ██║   ██╔══╝   ██╔██╗    ██║   %s\n' "$blue" "$c0"
  printf '%s  ╚██████╗╚██████╔╝██║ ╚████║   ██║   ███████╗██╔╝ ██╗   ██║   %s\n' "$blue" "$c0"
  printf '%s   ╚═════╝ ╚═════╝ ╚═╝  ╚═══╝   ╚═╝   ╚══════╝╚═╝  ╚═╝   ╚═╝   %s\n' "$blue" "$c0"
  printf '%s                 m e t e r   ·   пак модов Claude Code%s\n\n' "$dim" "$c0"

  # 1. Claude Code CLI: из PATH, из расширения редактора или официальным установщиком.
  step 'Ищу Claude Code'
  local claude=''
  if command -v claude >/dev/null 2>&1; then
    claude=$(command -v claude)
  elif [ -x "$HOME/.local/bin/claude" ]; then
    claude="$HOME/.local/bin/claude"
  else
    local f
    for f in "$HOME"/.vscode/extensions/anthropic.claude-code-*/resources/native-binary/claude* \
             "$HOME"/.vscode-insiders/extensions/anthropic.claude-code-*/resources/native-binary/claude* \
             "$HOME"/.cursor/extensions/anthropic.claude-code-*/resources/native-binary/claude* \
             "$HOME"/.windsurf/extensions/anthropic.claude-code-*/resources/native-binary/claude*; do
      [ -x "$f" ] && claude="$f"
    done
  fi
  if [ -z "$claude" ]; then
    if [ -n "$is_windows" ]; then
      # claude.ai/install.sh не работает в Git Bash: на Windows ставит PowerShell-установщик.
      printf '    %sClaude Code не найден, ставлю официальным установщиком (claude.ai/install.ps1)…%s\n' "$yellow" "$c0"
      powershell.exe -NoProfile -ExecutionPolicy Bypass -Command 'irm https://claude.ai/install.ps1 | iex'
    else
      printf '    %sClaude Code не найден, ставлю официальным установщиком (claude.ai/install.sh)…%s\n' "$yellow" "$c0"
      curl -fsSL https://claude.ai/install.sh | bash
    fi
    export PATH="$HOME/.local/bin:$PATH"
    if command -v claude >/dev/null 2>&1; then claude=$(command -v claude)
    elif [ -x "$HOME/.local/bin/claude.exe" ]; then claude="$HOME/.local/bin/claude.exe"
    fi
  fi
  if [ -z "$claude" ]; then
    printf '    %sНе удалось найти claude. Установите Claude Code (https://claude.com/claude-code) и запустите команду снова.%s\n' "$red" "$c0"
    return 1
  fi
  printf '    %s✓%s %s\n' "$green" "$c0" "$claude"

  # 2. Маркетплейс.
  step "Подключаю маркетплейс $repo"
  if "$claude" plugin marketplace add "$repo" >/dev/null 2>&1; then
    printf '    %s✓ добавлен%s\n' "$green" "$c0"
  else
    "$claude" plugin marketplace update "$market" >/dev/null 2>&1
    printf '    %s✓ уже был, обновил%s\n' "$green" "$c0"
  fi

  # 3. Моды.
  step 'Ставлю моды'
  local ok=0 failed=() installed=() entry name text out opt opts shown
  for entry in "${mods[@]}"; do
    name=${entry%%|*}
    text=${entry#*|}
    # Параметры мода из pluginConfigs старой установки переезжают как --config key=value.
    opts=()
    shown=''
    if [ -n "$py" ] && [ -f "$settings" ]; then
      while IFS= read -r opt; do
        [ -n "$opt" ] && opts+=(--config "$opt") && shown="$shown${shown:+, }$opt"
      done < <(PYTHONIOENCODING=utf-8 "$py" - "$settings" "$name" <<'PY' 2>/dev/null
import json, sys
s = json.load(open(sys.argv[1], encoding='utf-8'))
o = ((s.get('pluginConfigs') or {}).get(sys.argv[2]) or {}).get('options') or {}
for k, v in o.items():
    print('%s=%s' % (k, str(v).lower() if isinstance(v, bool) else v))
PY
)
    fi
    if out=$("$claude" plugin install "$name@$market" --scope user "${opts[@]}" 2>&1) || grep -qi 'already' <<<"$out"; then
      printf '    %s✓%s %s%-15s%s%s%s%s' "$green" "$c0" "$bold" "$name" "$c0" "$dim" "$text" "$c0"
      [ -n "$shown" ] && printf '  %s[%s]%s' "$cyan" "$shown" "$c0"
      printf '\n'
      ok=$((ok + 1))
      installed+=("$name")
    else
      printf '    %s✗%s %s%-15s%s%s%s%s\n' "$red" "$c0" "$bold" "$name" "$c0" "$dim" "$(tail -n 1 <<<"$out")" "$c0"
      failed+=("$name")
    fi
  done

  # 4. Те же моды, подключённые раньше папками или хуком, загрузились бы дважды:
  # убираем их из settings.json, остальное не трогаем, прежний файл кладём рядом копией.
  if [ ${#installed[@]} -gt 0 ] && [ -f "$settings" ]; then
    step 'Проверяю старое подключение в ~/.claude/settings.json'
    if [ -z "$py" ]; then
      if grep -q 'CLAUDE_CODE_PLUGIN_DIRS\|compact-notify' "$settings"; then
        printf '    %s! Нет python3, чтобы поправить settings.json. Если в CLAUDE_CODE_PLUGIN_DIRS или hooks%s\n' "$yellow" "$c0"
        printf '    %s  есть эти же моды, уберите их вручную, иначе они загрузятся дважды.%s\n' "$yellow" "$c0"
      fi
    elif out=$(PYTHONIOENCODING=utf-8 "$py" - "$settings" "${installed[@]}" <<'PY' 2>&1
import json, os, re, shutil, sys, time
path, names = sys.argv[1], set(sys.argv[2:])
s = json.load(open(path, encoding='utf-8'))
removed = []
env = s.get('env') or {}
dirs = env.get('CLAUDE_CODE_PLUGIN_DIRS')
if dirs:
    sep = ';' if ';' in dirs or re.match(r'^[A-Za-z]:', dirs) else ':'
    keep = []
    for d in [x for x in dirs.split(sep) if x]:
        name = os.path.basename(d.rstrip('/\\'))
        try:
            name = json.load(open(os.path.join(d, '.claude-plugin', 'plugin.json'), encoding='utf-8')).get('name', name)
        except Exception:
            pass
        (removed.append(name) if name in names else keep.append(d))
    if keep:
        env['CLAUDE_CODE_PLUGIN_DIRS'] = sep.join(keep)
    else:
        env.pop('CLAUDE_CODE_PLUGIN_DIRS', None)
    if not env:
        s.pop('env', None)
hooks = s.get('hooks')
if 'compact-notify' in names and isinstance(hooks, dict):
    for ev in list(hooks):
        groups = []
        for g in hooks[ev]:
            all_ = g.get('hooks', [])
            inner = [h for h in all_ if 'compact-notify.ps1' not in str(h.get('command', ''))]
            if len(inner) == len(all_):
                groups.append(g)
                continue
            removed.append('хук %s compact-notify' % ev)
            if inner:
                g['hooks'] = inner
                groups.append(g)
        if groups:
            hooks[ev] = groups
        else:
            del hooks[ev]
    if not hooks:
        s.pop('hooks', None)
if removed:
    shutil.copy(path, path + '.bak-' + time.strftime('%Y%m%d-%H%M%S'))
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(s, f, ensure_ascii=False, indent=2)
        f.write('\n')
print(', '.join(removed))
PY
); then
      if [ -n "$out" ]; then
        printf '    %s✓ убрал: %s%s\n' "$green" "$out" "$c0"
        printf '    %s  копия прежнего файла: settings.json.bak-*%s\n' "$dim" "$c0"
      else
        printf '    %s✓ дублей нет%s\n' "$green" "$c0"
      fi
    else
      printf '    %s! Не удалось разобрать settings.json: %s%s\n' "$yellow" "$(tail -n 1 <<<"$out")" "$c0"
    fi
  fi

  printf '\n'
  if [ ${#failed[@]} -eq 0 ]; then
    printf '  %s✔ Готово: %d из %d. Перезапустите Claude Code (терминал, VS Code или Desktop).%s\n' "$green" "$ok" "${#mods[@]}" "$c0"
  else
    printf '  %sУстановлено %d из %d. Не встали: %s%s\n' "$yellow" "$ok" "${#mods[@]}" "${failed[*]}" "$c0"
  fi
  printf '  %sНастройка: claude plugin configure <мод>, например session-pulse (ttlMinutes=60 для часового кэша).%s\n\n' "$dim" "$c0"
}

main "$@"
