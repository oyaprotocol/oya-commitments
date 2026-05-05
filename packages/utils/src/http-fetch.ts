interface HttpPostFetchOptions<TBody> {
    method: 'POST';
    headers: Readonly<Record<string, string>>;
    body: TBody;
    signal?: AbortSignal | undefined;
}

interface HttpTextResponse {
    ok: boolean;
    status: number;
    statusText: string;
    text(): Promise<string>;
}

type HttpFetchLike<TOptions, TResponse> = (
    url: string,
    options: TOptions
) => Promise<TResponse>;

type HttpPostFetchLike<TBody, TResponse = HttpTextResponse> = HttpFetchLike<
    HttpPostFetchOptions<TBody>,
    TResponse
>;

export type {
    HttpFetchLike,
    HttpPostFetchLike,
    HttpPostFetchOptions,
    HttpTextResponse,
};
