/**
 * @rule gql-query-paginates
 * @expect 1
 * @path packages/daemon/src/github/example.ts
 *
 * An interpolated template literal with first:N but no pageInfo is flagged.
 */

declare function graphql(query: string, variables?: Record<string, unknown>): Promise<unknown>;
declare const prNumber: number;

export async function getReviewThreads(): Promise<void> {
  await graphql(`query($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: ${prNumber}) {
        reviewThreads(first: 100) {
          nodes {
            id
            isResolved
            comments(last: 1) {
              nodes { author { login } body }
            }
          }
        }
      }
    }
  }`);
}
