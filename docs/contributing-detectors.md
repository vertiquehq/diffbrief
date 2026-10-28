<!--
SPDX-FileCopyrightText: 2026 Koivisto Capital Oy
SPDX-License-Identifier: EUPL-1.2
-->

# Contributing entry-point detector packs

diffbrief’s `entry-complexity` producer scores **cognitive complexity of the flow
behind each annotated entry point**, then diffs base vs head (human-review Complexity
tab, but Vertique-first).

## What ships in core

The built-in `vertique` profile understands:

| Annotation | Kind |
| --- | --- |
| JAX-RS `@GET` / `@POST` / … + `@Path` | `http` |
| `@McpTool` | `mcp` |
| `@KafkaSource` | `listener` |
| `@DelayedJobHandlerMethod` | `job` |

Spring, Quarkus, Micronaut, etc. are **not** enabled by default. Add them as packs.

## Pack format

JSON file (see [`contrib/spring.json`](../contrib/spring.json)):

```json
{
  "id": "spring",
  "annotations": [
    {
      "name": "GetMapping",
      "kind": "http",
      "httpMethod": "GET",
      "pathArgs": ["path", "value"]
    }
  ],
  "classPathAnnotations": [
    { "name": "RequestMapping", "pathArgs": ["path", "value"] }
  ],
  "methodPathAnnotations": []
}
```

Enable in `.github/diffbrief.json`:

```json
{
  "type": "entry-complexity",
  "profile": "vertique",
  "packs": ["contrib/spring.json"]
}
```

Copy the pack into your repo, or reference a path relative to the action checkout.

## Call graph and the event bus

The engine follows **typed method calls** in `src/main/java` (and method references).
A Vertique service client field typed as a contract interface resolves to project
implementations of that method name — so complexity past an event-bus proxy still
counts when you write `userService.getUser(id)`.

Raw `EventBusClient` / string addresses are **not** followed. That is intentional for
v1; prefer contract-typed clients in application code.

## Local check

```bash
node scripts/entry-complexity/snapshot.mjs --root /path/to/checkout
node scripts/entry-complexity/snapshot.mjs --root . --profile none --packs contrib/spring.json
```

## Snapshot schema

`schemaVersion: 1` objects with `entries[]` (`id`, `kind`, `httpMethod`, `path`,
`handler`, `flowCc`, `flow`). An external engine may write the same JSON; wire it with
a `command` producer or by extending this pack format.

## PR checklist for a new pack

1. Add `contrib/<ecosystem>.json` (or document an external URL).
2. Add a tiny fixture under `tests/fixtures/` proving detection.
3. Do **not** change the default `vertique` profile unless the annotation is Vertique’s.
