import { jsonResponse } from "~/server/utils/api-response";
import { requireBlogAccess } from "~/server/utils/blog-access";
import { createBlogPost, type PlatformBlogCreateInput } from "~/server/utils/content/publishing";
import { httpErrorDetails } from "~/server/utils/http-error";
import { finalizeRequestMetrics } from "~/server/utils/request-metrics";

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, "organizationId");
  const body = await readBody(event);

  if (!organizationId || Array.isArray(organizationId)) {
    return jsonResponse(
      { error: "Organization ID is required" }, { status: 400 }, );
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonResponse(
      { error: "Request body must be a valid object" }, { status: 400 }, );
  }

  try {
    const { env, db, session } = await requireBlogAccess(event, organizationId);

    const result = await createBlogPost(db, session.user.id, body as PlatformBlogCreateInput, {
      organization_id: organizationId, }, env);

    return jsonResponse(finalizeRequestMetrics(event, 'editor-blog-post-create', result));
  } catch (error) {
    console.error("Failed to create blog post:", error);
    const { message, statusCode } = httpErrorDetails(error, "Failed to create blog post");
    return jsonResponse(
      { error: message, ...(HTTPError.isError(error) && error.data ? { data: error.data } : {}) }, { status: statusCode }, );
  }
});
import { defineHandler, HTTPError } from 'nitro';
import { getRouterParam, readBody  } from 'nitro/h3';
