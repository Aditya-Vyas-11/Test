# Private Test Portal — Persistent Edition

## What is fixed
This version uses **PostgreSQL**, so tests, submissions, scores, feedback and subjective answer photos survive Render restarts/redeploys.

### Student workflow
Open `/test/<test-id>` → attempt → submit → MCQ score immediately → subjective answers wait for manual grading.

### Admin workflow
Open `/admin` → enter admin password → upload one `.json` test file → publish → copy the generated test link.

## Render setup
1. Create a Render PostgreSQL database.
2. Create a Render Web Service from this project.
3. Build command: `npm install`
4. Start command: `npm start`
5. Add environment variable `ADMIN_PASSWORD` with a strong private password.
6. Add environment variable `DATABASE_URL` using the PostgreSQL database's **Internal Database URL** from Render.
7. Deploy.
8. Open `https://YOUR-SERVICE.onrender.com/admin`.
9. Upload `sample-test.json` to verify everything.
10. Copy the generated `/test/<id>` link and send it.

## Important
- PostgreSQL is required. Without `DATABASE_URL`, the app intentionally refuses to start.
- Subjective photos are stored in PostgreSQL as binary data, so they remain available after restarts.
- The application limits uploaded answer images to 8 MB each.
- Keep the admin password private.
- This is designed for a small private testing workflow. For a large public platform, object storage would be preferable to storing images directly in Postgres.

## Test file
`sample-test.json` is a complete example. Future tests only need to follow the same schema:
- `type`: `mcq` or `subjective`
- `difficulty`: `Easy`, `Moderate`, `Hard`, `Very Hard`
- `marks`
- `question`
- MCQ: `options`, `answer`, `explanation`
- Subjective: `modelAnswer`
