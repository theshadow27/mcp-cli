/**
 * @rule gql-query-paginates
 * @expect 1
 * @path packages/daemon/src/github/example.ts
 *
 * A query with two connections where only one has pageInfo should be flagged.
 * The rule must check per-connection, not per-template.
 */

declare function graphql(query: string, variables?: Record<string, unknown>): Promise<unknown>;

export async function getFilesAndChecks(): Promise<void> {
  await graphql(`query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        files(first: 100) {
          pageInfo { hasNextPage endCursor }
          nodes { path additions deletions }
        }
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                contexts(first: 50) {
                  nodes { ... on CheckRun { name conclusion status } }
                }
              }
            }
          }
        }
      }
    }
  }`);
}
