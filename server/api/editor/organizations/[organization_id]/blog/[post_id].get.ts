import { jsonResponse } from "~/server/utils/api-response";
import { loadDashboardBlogPost } from '~/server/utils/dashboard-editor-resources'
import { httpErrorDetails } from "~/server/utils/http-error";

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, "organization_id");
  const postId = getRouterParam(event, "post_id");

  if (!organizationId || Array.isArray(organizationId)) {
    return jsonResponse(
      { error: "Organization ID is required" }, { status: 400 }, );
  }

  if (!postId || Array.isArray(postId)) {
    return jsonResponse(
      { error: "Post ID is required" }, { status: 400 }, );
  }

  try {
    return jsonResponse(await loadDashboardBlogPost(event, organizationId, postId));
  } catch (error) {
    console.error("Failed to get blog post:", error);
    const { message, statusCode } = httpErrorDetails(error, "Failed to get blog post");
    return jsonResponse(
      { error: message }, { status: statusCode }, );
  }
});
import { defineHandler } from 'nitro';
import { getRouterParam } from 'nitro/h3';
