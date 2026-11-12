import { jsonResponse } from "~/server/utils/api-response";
import { deleteBlogPost } from "~/server/utils/content/publishing";
import { httpErrorDetails } from "~/server/utils/http-error";
import { requireOrganizationAccess } from "~/server/utils/location-access";

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
    const { db } = await requireOrganizationAccess(event, organizationId);

    await deleteBlogPost(db, postId, organizationId);

    return jsonResponse({ success: true });
  } catch (error) {
    console.error("Failed to delete blog post:", error);
    const { message, statusCode } = httpErrorDetails(error, "Failed to delete blog post");
    return jsonResponse(
      { error: message }, { status: statusCode }, );
  }
});
import { defineHandler } from 'nitro';
import { getRouterParam } from 'nitro/h3';
