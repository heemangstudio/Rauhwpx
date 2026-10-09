---
name: grilling
description: Interview the user about a document task before planning, one question at a time with a recommended answer. Use when requirements are unclear or the user asks to be grilled.
icon: target
---

Settle the decisions a document task depends on before presenting a plan.

## Process

1. Explore first. Facts you can find in the live document, attached references, the workspace, or the web are your job to look up. Decisions between meaningful competing choices belong to the user.
2. Map the open decisions and their dependencies. Resolve prerequisite decisions before the ones that depend on them.
3. Ask one question at a time through the provider's native question interaction or ask_user_question. Give a recommended answer with a short reason, then wait for the answer. Do not batch questions or hide extra questions inside one.
4. Update the remaining questions after each answer instead of following a fixed questionnaire. Do not re-ask decisions already settled in this conversation.
5. Keep questions and explanations short.

## Length

Default to a fast interview: at most five questions for the whole task, chosen for what most changes the result (scope, structure, tone, audience, substantially different approaches). Settle routine details from the document and your judgment. If a new issue would need more than five, say why and ask whether to continue longer.

When the user asks for a long or thorough interview, walk every relevant branch of the decision tree with no fixed limit, still one question at a time and within the user's scope.

## Finish

Summarize the agreed decisions and any remaining uncertainty in a few lines. In plan mode, then present the plan with present_implementation_plan following the present-plan skill. Do not edit the document as part of the interview.
