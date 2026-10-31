import { describe, expect, it } from \"vitest\";
import express from \"express\";
import request from \"supertest\";
import { localeUploadRoutes } from \"./routes.js\";

function createTestApp(actorType = \"board\") {
  const app = express();
  app.use(express.json());
  // Mock actor middleware
  app.use((req, _res, next) => {
    (req as any).actor = { type: actorType, userId: \"user-123\" };
    next();
  });
  app.use(\"/api\", localeUploadRoutes());
  return app;
}

describe(\"locale-upload routes (OPE-10187)\", () => {
  it(\"POST /api/myrmidon/locales/validate: validates valid catalog JSON\", async () => {
    const app = createTestApp();
    const res = await request(app)
      .post(\"/api/myrmidon/locales/validate\")
      .send({
        locale: \"ru\",
        catalog: {
          app: {
            title: \"Мирмидон\",
          },
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.targetLocale).toBe(\"ru\");
    expect(res.body.baseLocale).toBe(\"en\");
    expect(res.body.report).toBeDefined();
    expect(res.body.report.totalCandidateKeys).toBe(1);
  });

  it(\"POST /api/myrmidon/locales/validate: rejects non-board actor\", async () => {
    const app = createTestApp(\"agent\");
    const res = await request(app)
      .post(\"/api/myrmidon/locales/validate\")
      .send({
        locale: \"ru\",
        catalog: { app: { title: \"Мирмидон\" } },
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe(\"Board access required\");
  });

  it(\"POST /api/myrmidon/locales/validate: rejects request missing locale\", async () => {
    const app = createTestApp();
    const res = await request(app)
      .post(\"/api/myrmidon/locales/validate\")
      .send({
        catalog: { app: { title: \"Мирмидон\" } },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(\"INVALID_LOCALE\");
  });

  it(\"POST /api/myrmidon/locales/validate: rejects malformed locale values\", async () => {
    const app = createTestApp();

    for (const locale of [\"!\", \"e\", \"ru de\", \"a\".repeat(36), \"ру\"]) {
      const res = await request(app)
        .post(\"/api/myrmidon/locales/validate\")
        .send({
          locale,
          catalog: { app: { title: \"Мирмидон\" } },
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe(\"INVALID_LOCALE\");
      expect(res.body.message).toContain(\"2-35\");
      expect(Array.isArray(res.body.errors)).toBe(true);
    }

    const ok = await request(app)
      .post(\"/api/myrmidon/locales/validate\")
      .send({ locale: \"custom-ru_2\", catalog: { app: { title: \"Мирмидон\" } } });
    expect(ok.status).toBe(200);
  });

  it(\"POST /api/myrmidon/locales/validate: rejects request missing catalog\", async () => {
    const app = createTestApp();
    const res = await request(app)
      .post(\"/api/myrmidon/locales/validate\")
      .send({
        locale: \"ru\",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(\"MISSING_CATALOG\");
  });

  it(\"POST /api/myrmidon/locales/validate: rejects invalid raw JSON content\", async () => {
    const app = createTestApp();
    const res = await request(app)
      .post(\"/api/myrmidon/locales/validate\")
      .send({
        locale: \"ru\",
        content: \"{ invalid json\",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(\"INVALID_CATALOG_JSON\");
  });

  it(\"POST /api/myrmidon/locales/validate: detects disallowed XSS payloads and fails validation\", async () => {
    const app = createTestApp();
    const res = await request(app)
      .post(\"/api/myrmidon/locales/validate\")
      .send({
        locale: \"ru\",
        catalog: {
          app: {
            title: \"<script>alert(1)</script>\",
          },
        },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(\"CATALOG_VALIDATION_FAILED\");
    expect(res.body.errors.some((e: any) => e.code === \"DISALLOWED_PAYLOAD\")).toBe(true);
  });

  it(\"POST /api/myrmidon/locales/validate: rejects invalid leaf types\", async () => {
    const app = createTestApp();
    const res = await request(app)
      .post(\"/api/myrmidon/locales/validate\")
      .send({
        locale: \"ru\",
        catalog: {
          app: {
            invalidLeaf: 42,
          },
        },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(\"CATALOG_VALIDATION_FAILED\");
    expect(res.body.errors.some((e: any) => e.code === \"INVALID_TYPE\")).toBe(true);
  });

  it(\"POST /api/myrmidon/locales/validate: supports multipart file upload\", async () => {
    const app = createTestApp();
    const res = await request(app)
      .post(\"/api/myrmidon/locales/validate\")
      .field(\"locale\", \"es\")
      .attach(\"file\", Buffer.from(JSON.stringify({ app: { title: \"Hola\" } })), \"catalog.json\");

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.targetLocale).toBe(\"es\");
  });
});
