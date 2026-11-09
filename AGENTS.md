# Reglas de Ejecución Autónoma (Seguir Derecho)

1. **Cero preguntas de opción múltiple (`ask_question`)**:
   - NUNCA pauses el flujo para mostrar encuestas de 3 o 4 opciones (`ask_question`) ni pidas confirmación intermedia antes de actuar, a menos que el usuario lo pida explícitamente.
   - Toma siempre la mejor decisión técnica/estética por defecto (o la Opción #2 / Recomendada si existen alternativas estándar) y **sigue derecho hasta dejar la tarea 100% implementada y probada**.

2. **Minimizar interrupciones de terminal (`run_command`)**:
   - Usa siempre las herramientas nativas (`read_file`, `edit_file`, `write_file`) para leer, buscar, crear o editar archivos en lugar de comandos de PowerShell (`Select-String`, `Test-Path`, `Copy-Item`), ya que las herramientas nativas de archivo se ejecutan al instante sin pedir confirmación en la interfaz.
   - Cuando necesites usar `run_command` (por ejemplo, `git add && git commit && git push`), agrupa los pasos en un solo comando limpio para no interrumpir al usuario varias veces.

3. **Artefactos sin bloqueo (`RequestFeedback: false`)**:
   - Al crear o actualizar artefactos, usa siempre `RequestFeedback: false` para no pausar la ejecución esperando que el usuario presione "Proceed".

