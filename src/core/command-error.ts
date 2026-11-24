export type CommandFailure = {
    command: string
    exitCode: number | string | null
    stderr: string
    signal: string | null
    timedOut: boolean
}
export class CommandError extends Error {
    readonly details: CommandFailure
    constructor(
        command: string,
        error: Error & { code?: number | string; stderr?: string; signal?: string; killed?: boolean }
    ) {
        const details: CommandFailure = {
            command,
            exitCode: error.code ?? null,
            stderr: String(error.stderr ?? '')
                .trimEnd()
                .split('\n')
                .slice(-40)
                .join('\n')
                .slice(-8000),
            signal: error.signal ?? null,
            timedOut:
                error.killed === true &&
                error.signal === 'SIGTERM' &&
                error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        }
        super(
            `外部コマンドが失敗: ${command}\n終了コード: ${details.exitCode ?? 'なし'} / シグナル: ${details.signal ?? 'なし'} / タイムアウト: ${details.timedOut ? 'はい' : 'いいえ'}\nstderr（末尾40行・最大8000文字）:\n${details.stderr || '（空）'}`,
            { cause: error }
        )
        this.name = 'CommandError'
        this.details = details
    }
}
