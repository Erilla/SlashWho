import { getContainer } from "../../../../../server/container";
import {
  apiError,
  jobStatusResponse,
  withHttpRequest
} from "../../../../../server/http";

export async function GET(
  _request: Request,
  context: { params: Promise<{ jobId: string }> }
): Promise<Response> {
  return withHttpRequest("job", async () => {
    const { jobId } = await context.params;
    const { searches } = await getContainer();
    const result = await searches.getRun(jobId);
    return result ? jobStatusResponse(result) : apiError("character_not_found");
  });
}
