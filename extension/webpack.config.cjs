const path = require("path");
const fs = require("fs");

const CopyPlugin = require("copy-webpack-plugin");
const { CleanWebpackPlugin } = require("clean-webpack-plugin");

function mergeJsonFiles(basePath, additionPath) {
    const baseManifest = JSON.parse(fs.readFileSync(basePath, "utf8"));
    const additionManifest = JSON.parse(fs.readFileSync(additionPath, "utf8"));

    return JSON.stringify(
        { ...baseManifest, ...additionManifest },
        null,
        2
    );
}

const generateConfig = (browser) => ({
    mode: "development",
    devtool: "inline-source-map",
    entry: {
        background: "./src/background.ts",
        content: "./src/content.ts",
        popup: "./src/popup.ts"
    },
    module: {
        rules: [
            {
                test: /\.tsx?$/,
                use: ["ts-loader"],
                exclude: /node_modules/,
            }
        ],
    },
    resolve: {
        extensions: [".ts"],
    },
    output: {
        filename: "[name].js",
        path: path.resolve(__dirname, `dist/${browser}`),
        clean: true,
    },
    plugins: [
        new CleanWebpackPlugin(),
        {
            apply: (compiler) => {
                compiler.hooks.emit.tap("MergeManifests", (compilation) => {
                    const mergedManifest = mergeJsonFiles(
                        path.resolve(__dirname, "manifest_base.json"),
                        path.resolve(__dirname, `manifest_${browser}.json`)
                    );
                    compilation.assets["manifest.json"] = {
                        source: () => mergedManifest,
                        size: () => mergedManifest.length
                    };
                });
            }
        },
        new CopyPlugin({
            patterns: [
                {
                    from: "static"
                }
            ]
        })
    ]
});

module.exports = [
    generateConfig("firefox"),
    generateConfig("chrome")
];
