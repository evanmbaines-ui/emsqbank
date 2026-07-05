# EMSqbank

EMS board-review question bank and evaluator workflow.

This project is a Python web app, not a static site. The frontend, API, login system, evaluator voting, learner mode, admin dashboard, exports, and persistent review storage are served by `web/server.py`.

## Deployment Summary

Use a Python app host such as Render. Do not deploy the final beta/live site with GitHub Pages alone, because static hosting cannot run the login or review APIs.

The repository includes:

- `render.yaml` for Render Blueprint deployment
- `web/server.py` for the app/API server
- `web/seed_data/question_bank.json` as the first-boot question-bank seed
- `web/server_data/.gitignore` so runtime secrets and review data are not committed

Runtime data must be stored on persistent server storage. On Render, the intended path is:

```text
/var/data
```

The app should run with:

```bash
python web/server.py serve --host 0.0.0.0 --port $PORT
```

See [web/README.md](web/README.md) for deployment, admin, password reset, and question lifecycle details.

