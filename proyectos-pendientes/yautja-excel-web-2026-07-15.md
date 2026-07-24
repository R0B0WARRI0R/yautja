# Yautja × Excel Web — integración

**Estado:** Brainstorming en pausa (Sección 1/5 presentada, pendiente aprobación)
**Fecha pausa:** 2026-07-15
**Fecha creación:** 2026-07-15
**Owner:** Jordic Carranza
**Skill relacionada:** `inspecting-excel-web` (a crear)

---

## Contexto

Nueva integración a Yautja MCP para interactuar con Excel Web (excel.cloud.microsoft, OneDrive Excel, SharePoint Excel). Motivación: extraer datos a JSON, cargar resultados de cálculos externos a hojas, y aplicar fórmulas complejas programáticamente — todo orquestado vía Yautja (browser MCP).

---

## Decisiones tomadas (acordadas con el usuario)

| # | Decisión | Valor |
|---|---|---|
| D1 | Alcance | **Híbrido: skill completa + 2-3 tools wrappers** |
| D2 | Casos de uso confirmados | 5: lectura→JSON, escritura masiva, fórmulas complejas, charts, formato+estilos |
| D3 | Modo de acceso | **Solo UI automation del navegador** (sin Microsoft Graph, sin Office.js directo) |
| D4 | Tamaño típico de rangos | **Pequeños/medianos (10-100 filas)** |
| D5 | Top 3 casos priorizados | **1) Fórmulas complejas, 2) Escritura masiva JSON/CSV, 3) Lectura → JSON** |
| D6 | Multi-archivo / multi-sheet | **DESCARTADO** del MVP |
| D7 | PivotTables / Charts avanzados | **DESCARTADO** del MVP (no encaja con UI-only) |
| D8 | Formato condicional avanzado | **DESCARTADO** del MVP (solo formato básico vía ribbon) |

---

## Diseño en progreso

### Sección 1/5 — Arquitectura general (PRESENTADA, pendiente aprobación)

```
C:\Users\jroca\.agents\skills\inspecting-excel-web\
  └── SKILL.md                              # playbook reutilizable

D:\Yautja\investigacion\excel-web-arquitectura.md   # doc técnico profundo

[repo Yautja MCP — modificación del código fuente]
  src/tools/excel/
    ├── read-range.ts                       # 3 nuevos tools
    ├── write-range.ts
    └── apply-formulas.ts
  src/tools/excel/index.ts                  # registro y exportación
  tests/excel/
    ├── read-range.spec.ts
    ├── write-range.spec.ts
    └── apply-formulas.spec.ts
```

**Capa skill:** auto-invoke cuando se mencione Excel/Spreadsheets/Microsoft 365.
**Capa wrappers:** 3 herramientas TypeScript que orquestan `yautja_act`/`yautja_findElement`/`yautja_smartType`/`yautja_observe`.
**Aislamiento:** cada wrapper opera sobre el archivo abierto en la pestaña activa.

### Secciones pendientes (NO PRESENTADAS)

- **Sección 2/5 — Componentes y contratos**
  - Firma exacta de cada wrapper (parámetros, retornos, errores tipados)
  - Cómo se comunican entre sí

- **Sección 3/5 — Flujo de datos end-to-end**
  - Ejemplo concreto: leer A1:Z100 → JSON → aplicar fórmulas → escribir de vuelta
  - Latencias esperadas por etapa

- **Sección 4/5 — Manejo de errores**
  - Errores tipados: `excel_sheet_not_found`, `excel_cell_locked`, `excel_range_too_large`, `excel_auth_expired`, etc.
  - Política de reintentos vs abort

- **Sección 5/5 — Testing y validación**
  - Cómo testear E2E sin Microsoft 365 de pago (cuenta developer)
  - Fixtures (archivos .xlsx canónicos)

---

## Próximos pasos al retomar

1. Confirmar Sección 1/5 (arquitectura) — aprobar o pedir cambios
2. Presentar Secciones 2-5 con aprobación incremental
3. Escribir design doc completo en `docs/superpowers/specs/YYYY-MM-DD-yautja-excel-web-design.md`
4. Spec self-review + revisión usuario
5. Invocar `writing-plans` para plan de implementación

---

## Contexto técnico pendiente de explorar (cuando volvamos)

- URL canónica actual: ¿excel.cloud.microsoft (nuevo M365) o excel.office.com (clásico)?
- Versión UI actual de Excel Web (build fingerprints en performance API)
- ¿Office.js expuesto en la página para atajos via `evaluate`? (aunque decidimos UI-only, saber qué hay disponible documenta el "no lo usamos porque…")
- ¿Soporte de rangos con nombre definido (Named Ranges)?
- ¿Hay API de undo robusto para rollback de operaciones?

---

## Referencias útiles para retomar

- Skill de brainstorming: `C:\Users\jroca\.cache\opencode\packages\superpowers@...\brainstorming\SKILL.md`
- Patrón a seguir: `inspecting-gemini/SKILL.md`, `inspecting-perplexity/SKILL.md`
- Specs previas en `docs/superpowers/specs/` (si existen) para convenciones de formato