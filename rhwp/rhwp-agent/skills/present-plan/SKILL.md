---
name: present-plan
description: Present a document editing plan for review, or revise an existing plan from concrete user feedback.
icon: system
---

Finish a requested plan through the structured plan review flow.

1. Use this skill when the user asks for a plan or gives concrete changes to an existing plan. Continue ordinary discussion and research without replacing the plan when no changes were requested.
2. Base the plan on the current live document before presenting: the latest `live_document` block, plus get_structure for what it lacks. Capture the goal, decisions, risks, assumptions, and exclusions. Write steps as a todo list of one-line imperative items, the way a coding agent tracks work: "Rewrite the 개요 paragraph so the goal comes first", "Merge the two schedule tables into one", "Verify the table fits one page via get_page_geometry". Put verification in its own todo items; add details, target, or preview only when the one-liner cannot carry it. Include actual sources as title plus URL or reference file/chunk IDs; never invent citations. Keep files only for relevant file work. Add a concise changeSummary for a revised version.
3. Call `present_implementation_plan` exactly once as the final action of the turn.
4. Do not tell the user the plan is ready until that tool returns success.
5. Do not call another tool afterward.
6. If the user requests concrete changes, inspect the affected state and present the replacement directly. Ask a question only when missing information blocks the revision. Applying any version still requires explicit approval.
