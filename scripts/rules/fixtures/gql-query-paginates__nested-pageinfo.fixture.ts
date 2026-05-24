/**
 * @rule gql-query-paginates
 * @expect 1
 * @path packages/daemon/src/github/example.ts
 *
 * Regression for the depth-1 false-negative: commits(first:10) has no direct
 * pageInfo, but the inner files(first:100) connection does. The inner pageInfo
 * must not suppress the violation on the outer commits connection.
 */

declare function graphql(query: string, variables?: Record<string, unknown>): Promise<unknown>;

export async function getCommitFiles(): Promise<void> {
  await graphql(`query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        commits(first: 10) {
          nodes {
            commit {
              files(first: 100) {
                pageInfo { hasNextPage endCursor }
                nodes { path additions deletions }
              }
            }
          }
        }
      }
    }
  }`);
}
