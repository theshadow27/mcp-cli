/**
 * @rule gql-query-paginates
 * @expect 1
 * @path packages/daemon/src/github/example.ts
 *
 * A first:100 query with no pageInfo selection should be flagged.
 */

declare function graphql(query: string, variables?: Record<string, unknown>): Promise<unknown>;

export async function getFiles(): Promise<void> {
  await graphql(`query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        files(first: 100) {
          nodes { path additions deletions }
        }
      }
    }
  }`);
}
