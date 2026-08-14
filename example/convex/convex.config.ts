import { defineApp } from "convex/server";
import improvedSearch from "convex-improved-search/convex.config.js";

const app = defineApp();
app.use(improvedSearch);

export default app;
