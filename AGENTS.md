# Reglas de Ejecución Autónoma (Seguir Derecho)

1. **Cero preguntas de opción múltiple (`ask_question`)**:
   - NUNCA pauses el flujo para mostrar encuestas de 3 o 4 opciones (`ask_question`) ni pidas confirmación intermedia antes de actuar, a menos que el usuario lo pida explícitamente.
   - Toma siempre la mejor decisión técnica/estética por defecto (o la Opción #2 / Recomendada si existen alternativas estándar) y **sigue derecho hasta dejar la tarea 100% implementada y probada**.

2. **PROHIBIDO usar `run_command` salvo para `git push` final**:
   - El usuario aún tiene confirmación manual en la interfaz para `run_command` (comandos de terminal). Por lo tanto, **NO uses `run_command`** para tareas intermedias, ni para crear archivos, ni para abrir el navegador.
   - Usa únicamente `read_file`, `edit_file`, `write_file` y el subagente `browser` (que no disparan el cuadro de opciones de terminal).

3. **Artefactos sin bloqueo (`RequestFeedback: false`)**:
   - Al crear o actualizar artefactos, usa siempre `RequestFeedback: false` para no pausar la ejecución esperando que el usuario presione "Proceed".

