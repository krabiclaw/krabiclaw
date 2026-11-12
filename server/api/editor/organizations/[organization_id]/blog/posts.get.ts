import { jsonResponse } from "~/server/utils/api-response";
import { loadDashboardBlogPosts } from '~/server/utils/dashboard-editor-resources'
import { httpErrorDetails } from "~/server/utils/http-error";

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, "organization_id");
  const query = getQuery(event);
  const status = typeof query.status === 'string' && query.status ? query.status : null;

  if (!organizationId || Array.isArray(organizationId)) {
    return jsonResponse(
      { error: "Organization ID is required" }, { status: 400 }, );
  }

  try {
    return jsonResponse(await loadDashboardBlogPosts(event, organizationId, {
      status,
      collection: typeof query.collection === 'string' && query.collection ? query.collection : null,
      ...(typeof query.limit === 'string' ? { limit: Number(query.limit) } : {}),
      ...(typeof query.cursor === 'string' ? { cursor: query.cursor } : {}),
    }));
  } catch (error) {
    console.error("Failed to list blog posts:", error);
    const { message, statusCode } = httpErrorDetails(error, "Failed to list blog posts");
    return jsonResponse(
      { error: message }, { status: statusCode }, );
  }
});
import { defineHandler } from 'nitro';
import { getQuery, getRouterParam  } from 'nitro/h3';
