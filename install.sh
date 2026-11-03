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
    printf '    %sClaude Code не найден, ставлю официальным установщиком (claude.ai/install.sh)…%s\n' "$yellow" "$c0"
    curl -fsSL https://claude.ai/install.sh | bash
    export PATH="$HOME/.local/bin:$PATH"
    command -v claude >/dev/null 2>&1 && claude=$(command -v claude)
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
  local ok=0 failed=() entry name text out
  for entry in "${mods[@]}"; do
    name=${entry%%|*}
    text=${entry#*|}
    if out=$("$claude" plugin install "$name@$market" --scope user 2>&1) || grep -qi 'already' <<<"$out"; then
      printf '    %s✓%s %s%-15s%s%s%s%s\n' "$green" "$c0" "$bold" "$name" "$c0" "$dim" "$text" "$c0"
      ok=$((ok + 1))
    else
      printf '    %s✗%s %s%-15s%s%s%s%s\n' "$red" "$c0" "$bold" "$name" "$c0" "$dim" "$(tail -n 1 <<<"$out")" "$c0"
      failed+=("$name")
    fi
  done

  # 4. Те же моды, подключённые папками, загрузились бы дважды.
  if grep -q 'CLAUDE_CODE_PLUGIN_DIRS' "$HOME/.claude/settings.json" 2>/dev/null; then
    printf '\n    %s! В ~/.claude/settings.json есть CLAUDE_CODE_PLUGIN_DIRS. Если там эти же моды из папок,%s\n' "$yellow" "$c0"
    printf '    %s  уберите их оттуда, иначе они загрузятся дважды.%s\n' "$yellow" "$c0"
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
