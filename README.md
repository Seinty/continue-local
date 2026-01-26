# Continue Dev (Локальная версия)

**Continue Dev** — локальная версия расширения для VS Code, позволяющая использовать чат с ИИ в IDE.

---

## Содержание

- [Описание](#описание)
- [Требования](#требования)
- [Установка](#установка)
- [Установка расширения](#установка-расширения)
- [Настройка расширения](#настройка-расширения)

---

## Описание

- Генерация кода на основе комментариев и строк кода
- Поддержка локальных моделей AI (`DeepSeek-Coder`)
- Управление API ключом через SecretStorage
- Поддержка Python, JavaScript, TypeScript, C++

---

## Требования

- Windows 10/11 или Linux/macOS
- VS Code ≥ 1.80.0
- Git
- NVM для Windows / Node.js LTS 20.19.0
- Доступ к локальному AI-серверу (по умолчанию `http://10.205.11.10:8003`)

> ⚠️ На Windows сборку лучше делать через Git Bash.

---

## Установка

1. Клонируем репозиторий:

```bash
git clone ..
cd continue-dev
```

2. Устанавливаем Node.js через NVM:

```bash
nvm install 20.19.0
nvm use 20.19.0
```

3. Устанавливаем зависимости:

```bash
Git Bash (Linux/macOS аналогично)
export NODE_OPTIONS="--max-old-space-size=4096"
./scripts/install-dependencies.sh
```

В директории `bash./extensions/vscode/build` будет находиться vsix файл с расширением.

---

## Установка расширения

Через интерфейс vscode: Extensions -> ... -> Install from VSIX.

---

## Настройка расширения

Для открытия панели расширения используется сочетание клавиш ctrl+l

В открывшемся окне над ячейкой диалога Local Config -> Configs ⚙, еще раз ⚙

Файл конфигурации следующий:

```
name: Local Config
version: 1.0.0
schema: v1
models:
  - name: DeepSeek LLM
    provider: openai
    model: DeepSeek-Coder
    apiBase: http://10.205.11.10:8003/v1
    apiKey: "" # Здесь необходимо указать свой ключ API
    roles:
      - chat
      - edit
      - apply
    #  - autocomplete (опционально, если нужен режим автодополнения строки)
```

Далее, если под диалоговым окном не появилось название модели DeepSeek LLM, то нажать select model и выбрать ее.
