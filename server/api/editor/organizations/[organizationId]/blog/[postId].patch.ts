import { jsonResponse } from "~/server/utils/api-response";
import { requireBlogAccess } from "~/server/utils/blog-access";
import { updateBlogPost, type PlatformBlogUpdateInput } from "~/server/utils/content/publishing";
import { httpErrorDetails } from "~/server/utils/http-error";
import { finalizeRequestMetrics } from "~/server/utils/request-metrics";

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, "organizationId");
  const postId = getRouterParam(event, "postId");
  const body = await readBody(event);

  if (!organizationId || Array.isArray(organizationId)) {
    return jsonResponse(
      { error: "Organization ID is required" }, { status: 400 }, );
  }

  if (!postId || Array.isArray(postId)) {
    return jsonResponse(
      { error: "Post ID is required" }, { status: 400 }, );
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonResponse(
      { error: "Request body must be a valid object" }, { status: 400 }, );
  }

  try {
    const { env, db, session } = await requireBlogAccess(event, organizationId);

    const result = await updateBlogPost(db, postId, body as PlatformBlogUpdateInput, organizationId, session.user.id, env);

    const payload = { success: true, changed: result.changed, post: result.post };
    return jsonResponse(finalizeRequestMetrics(event, 'editor-blog-post-update', payload));
  } catch (error) {
    console.error("Failed to update blog post:", error);
    const { message, statusCode } = httpErrorDetails(error, "Failed to update blog post");
    return jsonResponse(
      { error: message }, { status: statusCode }, );
  }
});
import { defineHandler } from 'nitro';
import { getRouterParam, readBody  } from 'nitro/h3';
