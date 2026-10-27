import { jsonResponse } from "~/server/utils/api-response";
import { finalizeRequestMetrics } from "~/server/utils/request-metrics";
import { requireBlogAccess } from "~/server/utils/blog-access";
import { parseBlogLifecycleInput, updateBlogLifecycle } from "~/server/utils/content/publishing";
import { httpErrorDetails } from "~/server/utils/http-error";

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, "organizationId");
  const postId = getRouterParam(event, "postId");

  if (!organizationId || Array.isArray(organizationId)) {
    return jsonResponse(
      { error: "Organization ID is required" }, { status: 400 }, );
  }

  if (!postId || Array.isArray(postId)) {
    return jsonResponse(
      { error: "Post ID is required" }, { status: 400 }, );
  }

  try {
    const { db, session } = await requireBlogAccess(event, organizationId);
    const input = parseBlogLifecycleInput(await readBody(event) as unknown);
    const lifecycle = await updateBlogLifecycle(db, postId, input, organizationId, session.user.id);

    return jsonResponse(finalizeRequestMetrics(event, "editor-blog-publish", { success: true, lifecycle }));
  } catch (error) {
    console.error("Failed to publish blog post:", error);
    const { message, statusCode } = httpErrorDetails(error, "Failed to publish blog post");
    return jsonResponse(
      { error: message }, { status: statusCode }, );
  }
});
import { defineHandler } from 'nitro';
import { getRouterParam, readBody  } from 'nitro/h3';
