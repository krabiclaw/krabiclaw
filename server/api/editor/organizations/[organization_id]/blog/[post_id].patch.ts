import { jsonResponse } from "~/server/utils/api-response";
import { requireWebsiteAccess, websiteEditorOrganization } from "~/server/utils/tenant-pages-api";
import { prepareBlogPost, updateBlogPost, type PlatformBlogUpdateInput } from "~/server/utils/content/publishing";
import { httpErrorDetails } from "~/server/utils/http-error";

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, "organization_id");
  const postId = getRouterParam(event, "post_id");
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
    const article = prepareBlogPost(postId, websiteEditorOrganization);
    const { env, db, userId, rows } = await requireWebsiteAccess(event, organizationId, article.queries);

    const result = await updateBlogPost(db, postId, body as PlatformBlogUpdateInput, organizationId, userId, env, article.snapshot(rows));

    const payload = { success: true, changed: result.changed, post: result.post };
    return jsonResponse(payload);
  } catch (error) {
    console.error("Failed to update blog post:", error);
    const { message, statusCode } = httpErrorDetails(error, "Failed to update blog post");
    return jsonResponse(
      { error: message }, { status: statusCode }, );
  }
});
import { defineHandler } from 'nitro';
import { getRouterParam, readBody  } from 'nitro/h3';
