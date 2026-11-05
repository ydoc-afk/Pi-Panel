# Default model per project

A project can have a default model. Every session in it that did not choose a model of its own runs
the default; with none set, pi uses its own default, as before.

Set it on the project's **Sessions** tab: pick a model in the Model select and press **Use for every
session in this project**. **Clear** next to the "Project default" line turns it off.

- It is resolved each time pi starts for a session, so changing the default also applies to sessions
  that already exist and did not choose a model. Press Stop/restart on a running session to pick up
  a change.
- A session created with a model of its own keeps it. The New session button leaves the model out
  when the select shows the project default, so those sessions follow the default.
- Provider failures are tracked against the provider the session actually used, default or chosen.
- Deleting the provider turns the default off.
- API: `PATCH /api/projects/:id` with `{"defaultModel": {"providerId": 1, "modelId": "x"}}`, or
  `{"defaultModel": null}`. Stored as `projects.default_provider_id` / `default_model_id`
  (migration 8).
