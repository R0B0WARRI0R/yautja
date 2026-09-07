# Instrucciones locales para agentes

Antes de modificar este repositorio:

1. Trata el árbol de trabajo existente como trabajo del usuario. Ejecuta
   `git status --short` y revisa diffs por archivo. No hagas limpiezas,
   restauraciones ni resets globales.
2. Si la tarea afecta a Mecamorph, sus herramientas `morph_*`, el adaptador
   `@mecamorph/yautja-adapter` o `semanticCompilation`, lee completamente
   `D:/Mecamorph/docs/HANDOFF.md` y las instrucciones enlazadas desde
   `D:/Mecamorph/AGENTS.md` antes de actuar.
3. Yautja conserva la propiedad del navegador, las sesiones, los gates y la
   política. Mecamorph no debe introducir un canal alternativo que los eluda.
4. El servidor MCP usa `stdio`: un proceso `helmet-main.js` iniciado a mano no
   sustituye al proceso que debe crear Codex.
