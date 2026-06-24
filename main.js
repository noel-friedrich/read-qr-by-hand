const elements = {
    choiceSvg: document.getElementById("qr-ecc-mask-choice-svg"),
    eccOutput: document.getElementById("chosen-ecc-level"),
    maskOutput: document.getElementById("chosen-mask"),
    versionSelect: document.getElementById("qr-version-select"),
    versionNameOutput: document.getElementById("version-name-output"),
    fillSvg: document.getElementById("qr-fill-svg"),
    byteTablesContainer: document.getElementById("byte-tables"),
    freeWorkspace: document.getElementById("free-workspace"),
    worksheetContainer: document.getElementById("worksheet-container"),
    printButton: document.getElementById("print-button"),
    printAllButton: document.getElementById("print-all-button"),
    maskingPatternTable: document.getElementById("masking-pattern-table"),
    backgroundSvg: document.getElementById("background-svg")
}

const url = new URL(window.location)

const ECC_LEVEL_PARAM = "e"
const MASK_PARAM = "m"
const VERSION_PARAM = "v"

const MaskingPatternFuncs = {
    0: (x, y) => (x + y) % 2 === 0,
    1: (x, y) => y % 2 === 0,
    2: (x, y) => x % 3 === 0,
    3: (x, y) => (x + y) % 3 === 0,
    4: (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    5: (x, y) => (x * y % 2) + (x * y % 3) === 0,
    6: (x, y) => ((x * y % 2) + (x * y % 3)) % 2 === 0,
    7: (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0
}

let highlightedDatablockIndex = null
let isPrintingWorksheetOnly = false

function initPageSlots() {
    document.querySelectorAll("main.main-container > .page").forEach(page => {
        const pageSlot = document.createElement("div")
        pageSlot.className = "page-slot"
        page.before(pageSlot)
        pageSlot.appendChild(page)
    })
}

function updatePageScale() {
    const pageWidth = 1000
    const pageHeight = 1414
    const pageMargin = 80
    const viewportWidth = window.visualViewport?.width || document.documentElement.clientWidth || window.innerWidth
    const scale = Math.min(1, viewportWidth / pageWidth)

    document.documentElement.style.setProperty("--page-scale", scale)
    document.documentElement.style.setProperty("--page-slot-width", `${pageWidth * scale}px`)
    document.documentElement.style.setProperty("--page-slot-height", `${pageHeight * scale}px`)
    document.documentElement.style.setProperty("--page-slot-margin", `${pageMargin * scale}px`)
}

const VersionECCBlockLayoutTable = {
    1: {"L": [1,  19], "M": [1, 16], "Q": [1, 13], "H": [1,  9]},
    2: {"L": [1,  34], "M": [1, 28], "Q": [1, 22], "H": [1, 16]},
    3: {"L": [1,  55], "M": [1, 44], "Q": [2, 34], "H": [2, 26]},
    4: {"L": [1,  80], "M": [2, 64], "Q": [2, 48], "H": [4, 36]},
    5: {"L": [1, 108], "M": [2, 86], "Q": [4, 62], "H": [4, 46]},
}

function loadQRParameters() {
    function loadParam(paramName, acceptableValues, defaultValue) {
        if (!url.searchParams.has(paramName)) {
            return defaultValue
        }

        const value = url.searchParams.get(paramName)
        if (acceptableValues.includes(value)) {
            return value
        } else {
            return defaultValue
        }
    }

    const params = {
        eccLevel: loadParam(ECC_LEVEL_PARAM, ["L", "M", "Q", "H"], "L"),
        mask: parseInt(loadParam(MASK_PARAM, ["0", "1", "2", "3", "4", "5", "6", "7"], "4")),
        version: parseInt(loadParam(VERSION_PARAM, ["1", "2", "3", "4", "5"], "1")),
    }

    elements.versionSelect.value = params.version

    return params
}

function saveQRParameters() {
    url.searchParams.set(ECC_LEVEL_PARAM, qrParameters.eccLevel)
    url.searchParams.set(MASK_PARAM, qrParameters.mask)
    url.searchParams.set(VERSION_PARAM, qrParameters.version)
    window.history.replaceState({}, "", url)
}

function updateQrParameters() {
    elements.eccOutput.textContent = qrParameters.eccLevel
    elements.maskOutput.textContent = qrParameters.mask
    elements.versionNameOutput.textContent = getQRName()

    resetFillSvg()
    saveQRParameters()
}

let qrParameters = null

function getQRName() {
    return `V${qrParameters.version}${qrParameters.eccLevel}${qrParameters.mask}`
}

const QrCellUnknownValue = "unknown"

class QrCell {

    constructor({value=false, mutableId=null, overlayColor=null, isStrikeThrough=false}={}) {
        this.value = value
        this.mutableId = mutableId
        this.overlayColor = overlayColor
        this.isStrikeThrough = isStrikeThrough
    }

    get isMutable() {
        return !!this.mutableId
    }

}

function qrFormatBchBits(eccLevelBits, maskPatternBits) {
    // These 5 bits are assumed to already be XORed with the first 5 bits of the QR format mask: 10101
    const maskedDataBits = eccLevelBits + maskPatternBits
    const maskedData = parseInt(maskedDataBits, 2)

    // Undo the mask before computing BCH
    const data = maskedData ^ 0b10101
    const generator = 0b10100110111
    let value = data << 10

    // Polynomial long division over GF(2)
    for (let bit = 14; bit >= 10; bit--) {
        if ((value >> bit) & 1) {
            value ^= generator << (bit - 10)
        }
    }

    const bch = value & 0b1111111111
    const maskedBch = bch ^ 0b0000010010
    return maskedBch.toString(2).padStart(10, "0")
}

class QrCode {

    constructor(pixelData) {
        this.pixelData = pixelData
    }

    get size() {
        return {
            x: this.pixelData[0].length,
            y: this.pixelData.length,
        }
    }

    static fromSize(size, generator=()=> new QrCell()) {
        return new this(Array.from({length: size.y}, (_, y) => Array.from({length: size.x}, (_, x) => generator({x, y}))))
    }

    static fromStringArray(stringArray, mutableIdColorMap=null) {
        return this.fromSize({
            x: stringArray[0].length,
            y: stringArray.length
        }, ({x, y}) => {
            const char = stringArray[y][x]
            if (char === "0" || char === "1") {
                return new QrCell({value: char === "1"})
            } else if (char === "?") {
                return new QrCell({value: QrCellUnknownValue})
            } else {
                return new QrCell({
                    value: false,
                    mutableId: char,
                    overlayColor: mutableIdColorMap ? mutableIdColorMap.get(char) : null
                })
            }
        })
    }

    isInBounds(pos) {
        return !(pos.x < 0 || pos.x >= this.size.x || pos.y < 0 || pos.y >= this.size.y)
    }

    getCellAt(pos) {
        if (!this.isInBounds(pos)) {
            return null
        }

        return this.pixelData[pos.y][pos.x]
    }

    getAllMutableIds() {
        return Array.from(new Set(this.pixelData.flat().map(p => p.mutableId).filter(Boolean)))
    }

    getReadPath(maxLength=Infinity) {
        const path = [[this.size.x - 1, this.size.y - 1]]

        let [currX, currY] = path[0]

        let directionIndex1 = 0
        let directionIndex2 = 0

        let moveDeltas = [
            [
                [-1, 0],
                [1, -1]
            ],
            [
                [-1, 0],
                [1, 1]
            ]
        ]

        const tempMoveBuffer = []

        let continueCount = 0
        while (true) {
            if (continueCount > 1) {
                break
            }

            let moveDelta = null
            if (tempMoveBuffer.length > 0) {
                moveDelta = tempMoveBuffer.shift()
                directionIndex1--
            } else {
                const moveDeltas1 = moveDeltas[directionIndex2 % moveDeltas.length]
                moveDelta = moveDeltas1[directionIndex1 % moveDeltas1.length]
            }

            const [newX, newY] = [currX + moveDelta[0], currY + moveDelta[1]]
            const cell = this.getCellAt({x: newX, y: newY})

            if (!cell) {
                directionIndex1 = 0
                directionIndex2++
                continueCount++

                tempMoveBuffer.push([-1, 0])
                if (currX === 7) {
                    tempMoveBuffer.push([-1, 0])
                }

                continue
            }

            if (cell && cell.isMutable) {
                path.push([newX, newY])
                if (path.length >= maxLength) {
                    return path
                }
            }

            currX = newX
            currY = newY

            directionIndex1++
            continueCount = 0
        }

        return path
    }

    drawToSvg(svg, {
        drawText=true,
        drawGridLines=true,
        drawReadPath=false,
        highlightedBlockIndex=null,
        maxReadPathLength=null,
        drawBlockIndeces=[]
    }={}) {
        svg.replaceChildren()
        svg.setAttribute("viewBox", `0 0 ${this.size.x} ${this.size.y}`)
        svg.setAttribute("preserveAspectRatio", "none")
        svg.setAttribute("shape-rendering", "geometricPrecision")
        svg.setAttribute("stroke-width", "0.03")

        const svgNamespace = "http://www.w3.org/2000/svg"
        const highlightOverlay = "rgba(0, 255, 0, 0.5)"

        function createSvgElement(tagName, attributes) {
            const element = document.createElementNS(svgNamespace, tagName)
            for (const [key, value] of Object.entries(attributes)) {
                element.setAttribute(key, value)
            }
            return element
        }

        // save where readPath goes to quickly find blockindex from coordinates later
        const readPath = this.getReadPath(maxReadPathLength)
        const blockIndexGrid = this.pixelData.map(row => row.map(c => null))

        for (let i = 0; i < readPath.length; i++) {
            const [gridX, gridY] = readPath[i]
            blockIndexGrid[gridY][gridX] = Math.floor(i / 4)
        }

        for (let y = 0; y < this.size.y; y++) {
            for (let x = 0; x < this.size.x; x++) {
                const cell = this.pixelData[y][x]

                let fillStyle = cell.value ? "black" : "white"
                if (cell.value === QrCellUnknownValue) {
                    fillStyle = "#bbbbbb"
                }

                if (cell.isStrikeThrough) {
                    svg.appendChild(createSvgElement("polygon", {
                        points: `${x},${y + 1} ${x + 1},${y} ${x},${y}`,
                        fill: fillStyle
                    }))

                    svg.appendChild(createSvgElement("line", {
                        x1: x,
                        y1: y + 1,
                        x2: x + 1,
                        y2: y,
                        stroke: "black",
                        // "stroke-width": 1,
                        // "vector-effect": "non-scaling-stroke"
                    }))
                } else {
                    svg.appendChild(createSvgElement("rect", {
                        x,
                        y,
                        width: 1,
                        height: 1,
                        fill: fillStyle
                    }))
                }

                if (drawText) {
                    const text = cell.value == QrCellUnknownValue ? "?" : (cell.value ? "1" : "0")
                    const textElement = createSvgElement("text", {
                        x: x + 0.5,
                        y: y + 0.55,
                        fill: cell.value ? "white" : "black",
                        "font-family": "monospace",
                        "font-size": 0.6,
                        "text-anchor": "middle",
                        "dominant-baseline": "middle"
                    })

                    textElement.textContent = text
                    svg.appendChild(textElement)
                }

                const absoluteBlockIndex = blockIndexGrid[y][x]

                // trust me, this works! (basically prioritizes overlaycolor over highlight and else none)
                const overlayColor = cell.overlayColor
                    ? cell.overlayColor
                    : (absoluteBlockIndex === null
                        ? null
                        : (absoluteBlockIndex === highlightedBlockIndex
                            ? highlightOverlay
                            : null))

                if (drawBlockIndeces.includes(absoluteBlockIndex)) {
                    const textElement = createSvgElement("text", {
                        x: x + 0.8,
                        y: y + 0.8,
                        fill: cell.value ? "white" : "black",
                        "font-family": "monospace",
                        "font-size": 0.4,
                        "text-anchor": "middle",
                        "dominant-baseline": "middle"
                    })

                    textElement.textContent = (absoluteBlockIndex + 1).toString()
                    svg.appendChild(textElement)
                }

                if (overlayColor) {
                    svg.appendChild(createSvgElement("rect", {
                        x,
                        y,
                        width: 1,
                        height: 1,
                        fill: overlayColor
                    }))
                }
            }
        }

        if (drawGridLines) {
            for (let x = 1; x < this.size.x; x++) {
                svg.appendChild(createSvgElement("line", {
                    x1: x,
                    y1: 0,
                    x2: x,
                    y2: this.size.y,
                    stroke: "black",
                    // "stroke-width": 1,
                    // "vector-effect": "non-scaling-stroke"
                }))
            }

            for (let y = 1; y < this.size.y; y++) {
                svg.appendChild(createSvgElement("line", {
                    x1: 0,
                    y1: y,
                    x2: this.size.x,
                    y2: y,
                    stroke: "black",
                    // "stroke-width": 1,
                    // "vector-effect": "non-scaling-stroke"
                }))
            }
        }

        if (drawReadPath) {
            const commands = [`M ${this.size.x} ${this.size.y - 0.5}`]

            for (let i = 1; i < readPath.length; i++) {
                const [gridX, gridY] = readPath[i]
                commands.push(`L ${gridX + 0.5} ${gridY + 0.5}`)
            }

            svg.appendChild(createSvgElement("path", {
                d: commands.join(" "),
                fill: "none",
                stroke: "green",
                "stroke-width": 0.06,
                // "vector-effect": "non-scaling-stroke"
            }))
        }
    }

    getMutableValues() {
        return new Map(this.getAllMutableIds().map(v => [v,
            parseInt(this.pixelData.flat().filter(c => c.mutableId === v).map(c => c.value ? "1" : "0").join(""), 2)
        ]))
    }

    getCellAtEvent(event, svg) {
        const rect = svg.getBoundingClientRect()
        const cellWidth = rect.width / this.size.x
        const cellHeight = rect.height / this.size.y

        const gridPos = {
            x: Math.floor((event.clientX - rect.left) / cellWidth),
            y: Math.floor((event.clientY - rect.top) / cellHeight)
        }

        return this.getCellAt(gridPos)
    }

    drawFinderPattern(pos) {
        for (let x = 0; x < 9; x++) {
            for (let y = 0; y < 9; y++) {
                const cell = this.getCellAt({x: x + pos.x - 1, y: y + pos.y - 1})
                if (cell) {
                    cell.mutableId = null
                }
            }
        }

        for (let x = 0; x < 7; x++) {
            for (let y = 0; y < 7; y++) {
                const cell = this.getCellAt({x: x + pos.x, y: y + pos.y})
                cell.value = !(x === 1 || y === 1 || x === 5 || y === 5) || x === 0 || y === 0 || x === 6 || y === 6
                cell.mutableId = null
            }
        }
    }

    drawAlignmentPattern(pos) {
        for (let x = 0; x < 5; x++) {
            for (let y = 0; y < 5; y++) {
                const cell = this.getCellAt({x: x + pos.x, y: y + pos.y})
                cell.value = (x === 0 || y === 0 || x === 4 || y === 4) || (x === 2 && y === 2)
                cell.mutableId = null
            }
        }
    }

    drawLine(startPos, moveDelta, numSteps, valueFunc=()=>true) {
        for (let i = 0; i < numSteps; i++) {
            const currPos = {
                x: startPos.x + moveDelta.x * i,
                y: startPos.y + moveDelta.y * i
            }

            const cell = this.getCellAt(currPos)
            cell.value = valueFunc(currPos)
            cell.mutableId = null
        }
    }

    drawValue(pos, moveDelta, binaryString, setImmutable=true) {
        for (let i = 0; i < binaryString.length; i++) {
            const currPos = {
                x: pos.x + moveDelta.x * i,
                y: pos.y + moveDelta.y * i
            }

            const cell = this.getCellAt(currPos)
            cell.value = (binaryString[i] === "1")

            if (setImmutable) {
                cell.mutableId = null
            }
        }
    }

    forEachCell(func) {
        this.pixelData.forEach((row, y) => row.forEach((cell, x) => func(cell, x, y)))
    }

    static fromParameters({eccLevel="L", version=1, mask=0}={}) {
        if (version > 5) {
            throw new Error("Version >5 not implemented.")
        }

        const size = (version * 4) + 17
        const qr = this.fromSize({x: size, y: size})
        qr.forEachCell(cell => cell.mutableId = "data")

        // draw the three eyes
        qr.drawFinderPattern({x: 0, y: 0})
        qr.drawFinderPattern({x: qr.size.x - 7, y: 0})
        qr.drawFinderPattern({x: 0, y: qr.size.y - 7})

        // draw timing lines
        qr.drawLine({x: 8, y: 6}, {x: 1, y: 0}, qr.size.x - 16, ({x, y}) => x % 2 === 0)
        qr.drawLine({x: 6, y: 8}, {x: 0, y: 1}, qr.size.y - 16, ({x, y}) => y % 2 === 0)

        // draw alignment pattern
        if (version > 1) {
            qr.drawAlignmentPattern({x: qr.size.x - 9, y: qr.size.y - 9})
        }

        // find parameter values
        const eccBits = {"H": "00", "Q": "01", "M": "10", "L": "11"}[eccLevel]
        const maskBits = (mask ^ 0b101).toString(2).padStart(3, "0")
        const bchBits = qrFormatBchBits(eccBits, maskBits)

        // draw parameter values
        qr.drawValue({x: 0, y: 8}, {x: 1, y: 0}, eccBits)
        qr.drawValue({x: 2, y: 8}, {x: 1, y: 0}, maskBits)
        qr.drawValue({x: 8, y: qr.size.y - 1}, {x: 0, y: -1}, eccBits)
        qr.drawValue({x: 8, y: qr.size.y - 3}, {x: 0, y: -1}, maskBits)

        // draw scattered BCH bits Copy A
        qr.drawValue({x: 5, y: 8}, {x: 1, y: 0}, bchBits.slice(0, 1))
        qr.drawValue({x: 7, y: 8}, {x: 1, y: 0}, bchBits.slice(1, 3))
        qr.drawValue({x: 8, y: 7}, {x: 0, y: -1}, bchBits.slice(3, 4))
        qr.drawValue({x: 8, y: 5}, {x: 0, y: -1}, bchBits.slice(4, 10))

        // draw scattered BCH bits Copy B
        qr.drawValue({x: 8, y: qr.size.y - 6}, {x: 0, y: -1}, bchBits.slice(0, 2))
        qr.drawValue({x: qr.size.x - 8, y: 8}, {x: 1, y: 0}, bchBits.slice(2, 10))

        // set dark module
        qr.drawValue({x: 8, y: qr.size.y - 8}, {x: 0, y: 0}, "1")

        // apply masking pattern as overlayColor
        const maskingFunc = MaskingPatternFuncs[mask]

        qr.forEachCell((cell, x, y) => {
            if (cell.isMutable) {
                if (maskingFunc(x, y)) {
                    // cell.overlayColor = "rgba(0, 0, 255, 0.3)"
                    cell.isStrikeThrough = true
                }
            } else {
                if (cell.value) {
                    cell.overlayColor = "rgba(255, 255, 255, 0.6)"
                } else {
                    cell.overlayColor = "rgba(0, 0, 0, 0.1)"
                }
            }
        })

        return qr
    }

}

function initChoiceSvg() {
    const qr = QrCode.fromStringArray([
        "11111110",
        "10000010",
        "10111010",
        "10111010",
        "10111010",
        "10000010",
        "11111110",
        "00000000",
        "xxyyy???",
    ], new Map([
        ["x", "rgba(255, 0, 0, 0.5)"],
        ["y", "rgba(0, 0, 255, 0.5)"]
    ]))

    const eccBits = {"H": "00", "Q": "01", "M": "10", "L": "11"}[qrParameters.eccLevel]
    const maskBits = (qrParameters.mask ^ 0b101).toString(2).padStart(3, "0")
    qr.drawValue({x: 0, y: 8}, {x: 1, y: 0}, eccBits, false)
    qr.drawValue({x: 2, y: 8}, {x: 1, y: 0}, maskBits, false)

    function redraw() {
        qr.drawToSvg(elements.choiceSvg, {drawGridLines: false})
    }

    function updateVars() {
        const varValues = qr.getMutableValues()

        qrParameters.eccLevel = {
            0b11: "L",
            0b10: "M",
            0b01: "Q",
            0b00: "H"
        }[varValues.get("x")]

        qrParameters.mask = varValues.get("y") ^ 0b101

        updateQrParameters()
    }

    updateVars()

    elements.choiceSvg.addEventListener("click", (event) => {
        const cell = qr.getCellAtEvent(event, elements.choiceSvg)
        if (cell?.isMutable) {
            cell.value = !cell.value
        }

        updateVars()
        redraw()
    })

    elements.choiceSvg.addEventListener("mousemove", (event) => {
        const cell = qr.getCellAtEvent(event, elements.choiceSvg)
        if (!cell) {
            return
        }

        if (cell.isMutable) {
            elements.choiceSvg.style.cursor = "pointer"
        } else {
            elements.choiceSvg.style.cursor = "initial"
        }
    })

    addEventListener("resize", redraw)

    redraw()
}

let digitInputMap = null

function resetByteTable() {
    elements.byteTablesContainer.innerHTML = ""
    const allowedHexValues = Array.from({length: 16}, (_, i) => i.toString(16).toUpperCase())

    const [numBlocks, totalBlocksLength] = VersionECCBlockLayoutTable[qrParameters.version][qrParameters.eccLevel]

    const shortLength = Math.floor(totalBlocksLength / numBlocks)
    const longLength = shortLength + 1
    const longCount = totalBlocksLength % numBlocks
    const shortCount = numBlocks - longCount

    // entire calculation before was in terms of 8-bit blocks, but in this tutorial, we want to read 4-bit blocks (Fblocks)
    const FblockSizes = Array.from({length: numBlocks}, (_, i) => i >= shortCount ? longLength * 2 : shortLength * 2)
    const totalFblocksLength = totalBlocksLength * 2

    const columnsPerTable = 24

    digitInputMap = Array.from({length: totalFblocksLength})

    for (let blockSizeIndex = 0; blockSizeIndex < numBlocks; blockSizeIndex++) {
        const blockSize = FblockSizes[blockSizeIndex]
        const label = document.createElement("label")
        label.classList.add("byte-table-label")

        if (numBlocks > 1) {
            label.textContent = `Data block ${blockSizeIndex + 1} (${blockSize} digits, ${Math.round(blockSize / 2)} bytes)`
        } else {
            label.textContent = `Data block (${blockSize} digits, ${Math.round(blockSize / 2)} bytes)`
        }

        elements.byteTablesContainer.appendChild(label)

        const byteTable = document.createElement("div")
        byteTable.classList.add("byte-table")
        byteTable.style.gridTemplateColumns = `repeat(${columnsPerTable}, 1fr)`

        for (let i = 0; i < blockSize; i++) {
            const byteIndex = Math.floor(i / 2)
            const nibbleIndex = i % 2

            let absoluteBlockIndex = null
            if (byteIndex < shortLength) {
                absoluteBlockIndex = (byteIndex * numBlocks + blockSizeIndex) * 2 + nibbleIndex
            } else {
                absoluteBlockIndex = (shortLength * numBlocks + (blockSizeIndex - shortCount)) * 2 + nibbleIndex
            }

            const cellElement = document.createElement("div")
            cellElement.classList.add("byte-cell")

            if (absoluteBlockIndex < 9) {
                cellElement.classList.add("show-blockindex")
                cellElement.dataset.blockindex = absoluteBlockIndex + 1
            }

            const input = document.createElement("input")
            input.setAttribute("type", "text")

            cellElement.appendChild(input)
            byteTable.appendChild(cellElement)

            if (i % columnsPerTable === 0) {
                cellElement.classList.add("first-column")
            }

            if ((i + 1) % columnsPerTable === 0) {
                cellElement.classList.add("last-column")
            }

            input.addEventListener("input", () => {
                let newValue = input.value.toUpperCase().slice(-1)

                if (newValue === "N") {
                    // cheat mode! read the actual cell data and go get it!

                    const readPath = fillQr.getReadPath(digitInputMap.length * 4)
                    const valueBuffer = []

                    for (let i = absoluteBlockIndex * 4; i < (absoluteBlockIndex + 1) * 4; i++) {
                        const [x, y] = readPath[i]
                        const cell = fillQr.getCellAt({x, y})
                        let readValue = !!cell.value
                        if (cell.isStrikeThrough) {
                            readValue = !readValue
                        }

                        valueBuffer.push(readValue)
                    }

                    const correctDigit = parseInt(valueBuffer.map(v => v ? "1" : "0").join(""), 2).toString(16).toUpperCase()
                    input.value = correctDigit

                    if (absoluteBlockIndex < totalFblocksLength - 1) {
                        digitInputMap[absoluteBlockIndex + 1].focus()
                    }

                    return
                }

                if (!allowedHexValues.includes(newValue)) {
                    input.value = ""
                    return
                }

                input.value = newValue
                if (absoluteBlockIndex < totalFblocksLength - 1) {
                    digitInputMap[absoluteBlockIndex + 1].focus()
                }
            })

            digitInputMap[absoluteBlockIndex] = input
            input.dataset.inputOrderKey = absoluteBlockIndex

            input.addEventListener("keydown", event => {
                if (event.key === "Tab") {
                    if (event.shiftKey) {
                        if (absoluteBlockIndex > 0) {
                            digitInputMap[absoluteBlockIndex - 1].focus()
                            event.preventDefault()
                        }
                    } else if (absoluteBlockIndex < totalFblocksLength - 1) {
                        digitInputMap[absoluteBlockIndex + 1].focus()
                        event.preventDefault()
                    }
                }

                if (event.key === "Backspace" && input.value.length == 0) {
                    if (absoluteBlockIndex > 0) {
                        input.value = ""
                        digitInputMap[absoluteBlockIndex - 1].focus()
                        event.preventDefault()
                    }
                }
            })

            input.addEventListener("focusin", () => {
                highlightedDatablockIndex = absoluteBlockIndex
                redrawFillSvg()
            })

            input.addEventListener("focusout", () => {
                highlightedDatablockIndex = null
                redrawFillSvg()
            })
        }

        elements.byteTablesContainer.appendChild(byteTable)
    }
}

function resetFreeWorkspace() {
    elements.freeWorkspace.style.height = ""

    const styles = getComputedStyle(elements.worksheetContainer)
    const fontSize = parseFloat(styles.fontSize)
    const paddingTop = parseFloat(styles.paddingTop)
    const paddingBottom = parseFloat(styles.paddingBottom)
    const worksheetHeight = elements.worksheetContainer.clientHeight
    const usableHeight = worksheetHeight - paddingTop - paddingBottom
    const freeWorkspaceTop = elements.freeWorkspace.offsetTop - paddingTop
    const freeSpace = usableHeight - freeWorkspaceTop

    if (fontSize > 0 && freeSpace / usableHeight > 0.1) {
        elements.freeWorkspace.style.height = `${freeSpace / fontSize}em`
        elements.freeWorkspace.classList.add("visible")
    } else {
        elements.freeWorkspace.classList.remove("visible")
    }
}

function updatePrintLayout() {
    resetFreeWorkspace()
    requestAnimationFrame(resetFreeWorkspace)
}

let fillQr = null
function redrawFillSvg() {
    const [numBlocks, totalBlocksLength] = VersionECCBlockLayoutTable[qrParameters.version][qrParameters.eccLevel]
    const totalFblocksLength = totalBlocksLength * 2

    fillQr.drawToSvg(elements.fillSvg, {
        drawText: false,
        drawReadPath: true,
        maxReadPathLength: totalFblocksLength * 4,
        highlightedBlockIndex: highlightedDatablockIndex,
        drawBlockIndeces: Array.from({length: 9}, (_, i) => i)
    })
}

function resetFillSvg() {
    if (fillQr === null) {
        elements.fillSvg.addEventListener("click", (event) => {
            const cell = fillQr.getCellAtEvent(event, elements.fillSvg)
            if (cell?.isMutable) {
                cell.value = !cell.value
            }

            redrawFillSvg()
        })

        elements.fillSvg.addEventListener("mousemove", (event) => {
            const cell = fillQr.getCellAtEvent(event, elements.fillSvg)
            if (!cell) {
                return
            }

            if (cell.isMutable) {
                elements.fillSvg.style.cursor = "pointer"
            } else {
                elements.fillSvg.style.cursor = "initial"
            }
        })
    }

    fillQr = QrCode.fromParameters(qrParameters)
    redrawFillSvg()
    resetByteTable()
    resetFreeWorkspace()
}

function initVersionSelect() {
    const updateVersionValue = () => {
        qrParameters.version = parseInt(elements.versionSelect.value)
        updateQrParameters()
    }

    elements.versionSelect.addEventListener("change", updateVersionValue)
    updateVersionValue()
}

function initPrintButtons() {
    elements.printAllButton.addEventListener("click", () => {
        window.open(`pdfs/full-${getQRName()}.pdf`, "_blank").focus()
    })

    elements.printButton.addEventListener("click", () => {
        window.open(`pdfs/${getQRName()}.pdf`, "_blank").focus()
    })
}

async function fillDatablockAutomatically() {
    const readPath = fillQr.getReadPath(digitInputMap.length * 4)
    const valueBuffer = []

    for (let i = 0; i < readPath.length; i++) {
        const [x, y] = readPath[i]
        const cell = fillQr.getCellAt({x, y})
        let readValue = !!cell.value
        if (cell.isStrikeThrough) {
            readValue = !readValue
        }

        valueBuffer.push(readValue)

        if (valueBuffer.length === 4) {
            const digit = parseInt(valueBuffer.map(v => v ? "1" : "0").join(""), 2).toString(16).toUpperCase()
            digitInputMap[Math.floor(i / 4)].value = digit
            valueBuffer.splice(0, 4)

            await new Promise(resolve => setTimeout(resolve, 10))
        }
    }
}

function initMaskingPatternTable() {
    const trs = Array.from(elements.maskingPatternTable.querySelectorAll("tr"))

    for (let y = 0; y < 2; y++) {
        const tr = document.createElement("tr")
        for (let x = 0; x < 4; x++) {
            const patternFunc = MaskingPatternFuncs[y * 4 + x]
            const td = document.createElement("td")

            const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
            const qr = QrCode.fromSize({x: 12, y: 12}, ({x, y}) => {
                return new QrCell({value: patternFunc(x, y)})
            })

            svg.style.minWidth = "0"
            svg.style.display = "block"
            svg.style.width = "100%"
            svg.style.aspectRatio = "1 / 1"

            qr.drawToSvg(svg, {drawText: false})
            td.appendChild(svg)

            tr.appendChild(td)
        }

        elements.maskingPatternTable.insertBefore(tr, trs[y * 2 + 1])
    }
}

let randomBackgroundPatternIndex = null
function initBackground() {
    // make for a consistent pattern across many (resize-triggered) calls
    if (randomBackgroundPatternIndex === null) {
        randomBackgroundPatternIndex = Math.floor(Math.random() * 8)
    }

    const randomPattern = MaskingPatternFuncs[randomBackgroundPatternIndex]

    const qrSize = {
        x: Math.round(window.innerWidth / 40),
        y: Math.round(window.innerHeight / 40),
    }

    const qr = QrCode.fromSize(qrSize, ({ x, y }) => {
        if (randomPattern(x, y)) {
            const [xPercent, yPercent] = [Math.random(), Math.random()]
            const overlayColor = `hsla(${xPercent * 360}, 100%, ${yPercent * 30 + 40}%, 1)`
            return new QrCell({ value: true, overlayColor })
        } else {
            return new QrCell({ value: false})
        }
    })

    qr.drawToSvg(elements.backgroundSvg, {drawText: false, drawGridLines: false})
}

function main() {
    initPageSlots()
    updatePageScale()
    qrParameters = loadQRParameters()
    updateQrParameters()
    initChoiceSvg()
    initVersionSelect()
    resetFillSvg()
    initPrintButtons()
    initMaskingPatternTable()
    initBackground()

    window.addEventListener("resize", initBackground)
    window.addEventListener("resize", redrawFillSvg)
    window.addEventListener("resize", resetFreeWorkspace)
    // window.addEventListener("resize", updatePageScale)
    // window.addEventListener("orientationchange", updatePageScale)
    // window.visualViewport?.addEventListener("resize", updatePageScale)
}

window.addEventListener("load", main)
