// The build reads .svg files as text: Otus's icons and token logos live in assets/ as files.
declare module '*.svg' {
    const text: string;
    export default text;
}
