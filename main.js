const elements = {
    choiceCanvas: document.getElementById("qr-ecc-mask-choice-canvas"),
    eccOutput: document.getElementById("chosen-ecc-level"),
    maskOutput: document.getElementById("chosen-mask"),
    versionSelect: document.getElementById("qr-version-select"),
    versionNameOutput: document.getElementById("version-name-output"),
    fillCanvas: document.getElementById("qr-fill-canvas"),
    byteTablesContainer: document.getElementById("byte-tables"),
    freeWorkspace: document.getElementById("free-workspace"),
    worksheetContainer: document.getElementById("worksheet-container"),
    printButton: document.getElementById("print-button")
}

const PRINT_SCALE = 2

const fillContext = elements.fillCanvas.getContext("2d")
const url = new URL(window.location)

const ECC_LEVEL_PARAM = "e"
const MASK_PARAM = "m"
const VERSION_PARAM = "v"

let highlightedDatablockIndex = null

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
        version: parseInt(loadParam(VERSION_PARAM, ["1", "2", "3", "4", "5"], "3")),
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
    elements.versionNameOutput.textContent = `V${qrParameters.version}${qrParameters.eccLevel}${qrParameters.mask}`

    resetFillCanvas()
    saveQRParameters()
}

let qrParameters = null

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

    drawToCanvas(context, {
        drawText=true,
        drawGridLines=true,
        drawReadPath=false,
        highlightedBlockIndex=null,
        maxReadPathLength=null,
        printMode=false
    }={}) {
        const scalingFactor = printMode ? PRINT_SCALE : 1.0

        context.clearRect(0, 0, context.canvas.width, context.canvas.height)
        context.canvas.width = context.canvas.clientWidth * scalingFactor
        context.canvas.height = context.canvas.clientHeight * scalingFactor

        const cellWidth = context.canvas.width / this.size.x
        const cellHeight = context.canvas.height / this.size.y
        const highlightOverlay = "rgba(0, 255, 0, 0.5)"

        context.font = `${cellWidth * 0.6}px monospace`
        context.textBaseline = "middle"
        context.textAlign = "center"

        // save where readPath goes to quickly find blockindex from coordinates later
        const readPath = this.getReadPath(maxReadPathLength)
        const blockIndexGrid = this.pixelData.map(row => row.map(c => null))

        for (let i = 0; i < readPath.length; i++) {
            const [gridX, gridY] = readPath[i]
            blockIndexGrid[gridY][gridX] = Math.floor(i / 4)
        }

        for (let y = 0; y < this.size.y; y++) {
            for (let x = 0; x < this.size.x; x++) {
                const xPos = (x / this.size.x) * context.canvas.width
                const yPos = (y / this.size.y) * context.canvas.height
                const cell = this.pixelData[y][x]

                context.fillStyle = cell.value ? "black" : "white"
                if (cell.value === QrCellUnknownValue) {
                    context.fillStyle = "#bbbbbb"
                }

                if (cell.isStrikeThrough) {
                    context.beginPath()
                    context.moveTo(xPos, yPos + cellHeight)
                    context.lineTo(xPos + cellWidth, yPos)
                    context.lineTo(xPos, yPos)
                    context.fill()

                    context.beginPath()
                    context.moveTo(xPos, yPos + cellHeight)
                    context.lineTo(xPos + cellWidth, yPos)
                    context.strokeStyle = "black"
                    context.lineWidth = 1
                    context.stroke()
                } else {
                    context.fillRect(xPos, yPos, cellWidth + 1, cellHeight + 1)
                }

                if (drawText) {
                    context.fillStyle = cell.value ? "white" : "black"
                    const text = cell.value == QrCellUnknownValue ? "?" : (cell.value ? "1" : "0")

                    // y * 0.55 instead of 0.5 just looks better
                    context.fillText(text, xPos + cellWidth / 2, yPos + cellHeight * 0.55)
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
                
                if (overlayColor) {
                    context.fillStyle = overlayColor
                    context.fillRect(xPos, yPos, cellWidth + 1, cellHeight + 1)
                }
            }
        }

        if (drawGridLines) {
            context.lineWidth = 1

            for (let x = 1; x < this.size.x; x++) {
                context.beginPath()
                context.moveTo(x * cellWidth, 0)
                context.lineTo(x * cellWidth, context.canvas.height)
                context.strokeStyle = "black"
                context.stroke()
            }
            
            for (let y = 1; y < this.size.y; y++) {
                context.beginPath()
                context.moveTo(0, y * cellHeight)
                context.lineTo(context.canvas.width, y * cellHeight)
                context.strokeStyle = "black"
                context.stroke()
            }
        }

        if (drawReadPath) {
            context.beginPath()
            context.moveTo(cellWidth * this.size.x, cellHeight * (this.size.y - 0.5))

            for (let i = 1; i < readPath.length; i++) {
                const [gridX, gridY] = readPath[i]
                const xPos = (gridX + 0.5) * cellWidth
                const yPos = (gridY + 0.5) * cellHeight

                context.lineTo(xPos, yPos)
            }

            context.lineWidth = 2
            context.strokeStyle = "green"
            context.stroke()
        }
    }

    getMutableValues() {
        return new Map(this.getAllMutableIds().map(v => [v,
            parseInt(this.pixelData.flat().filter(c => c.mutableId === v).map(c => c.value ? "1" : "0").join(""), 2)
        ]))
    }

    getCellAtEvent(event, context) {
        const cellWidth = context.canvas.clientWidth / this.size.x
        const cellHeight = context.canvas.clientHeight / this.size.y
        const rect = context.canvas.getBoundingClientRect()

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
        const maskingFunc = {
            0: (x, y) => (x + y) % 2 === 0,
            1: (x, y) => y % 2 === 0,
            2: (x, y) => x % 3 === 0,
            3: (x, y) => (x + y) % 3 === 0,
            4: (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
            5: (x, y) => (x * y % 2) + (x * y % 3) === 0,
            6: (x, y) => ((x * y % 2) + (x * y % 3)) % 2 === 0,
            7: (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0
        }[mask]

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

function initChoiceCanvas() {
    const context = elements.choiceCanvas.getContext("2d")

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
        qr.drawToCanvas(context, {drawGridLines: false})
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

    context.canvas.addEventListener("click", (event) => {
        const cell = qr.getCellAtEvent(event, context)
        if (cell?.isMutable) {
            cell.value = !cell.value
        }

        updateVars()
        redraw()
    })

    context.canvas.addEventListener("mousemove", (event) => {
        const cell = qr.getCellAtEvent(event, context)
        if (!cell) {
            return
        }

        if (cell.isMutable) {
            context.canvas.style.cursor = "pointer"
        } else {
            context.canvas.style.cursor = "initial"
        }
    })

    addEventListener("resize", redraw)

    redraw()
}

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

    const inputOrderMap = Array.from({length: totalFblocksLength})
    
    for (let blockSizeIndex = 0; blockSizeIndex < numBlocks; blockSizeIndex++) {
        const blockSize = FblockSizes[blockSizeIndex]
        const label = document.createElement("label")
        label.classList.add("byte-table-label")

        if (numBlocks > 1) {
            label.textContent = `Data block ${blockSizeIndex + 1} (${blockSize} digits)`
        } else {
            label.textContent = `Data block (${blockSize} digits)`
        }
        
        elements.byteTablesContainer.appendChild(label)

        const byteTable = document.createElement("div")
        byteTable.classList.add("byte-table")
        byteTable.style.gridTemplateColumns = `repeat(${columnsPerTable}, 1fr)`

        for (let i = 0; i < blockSize; i++) {
            const cellElement = document.createElement("div")
            cellElement.classList.add("byte-cell")
    
            const input = document.createElement("input")
            input.setAttribute("type", "text")
    
            cellElement.appendChild(input)
            byteTable.appendChild(cellElement)

            if (i % columnsPerTable === 0) {
                cellElement.classList.add("first-column")
            } 
    
            input.addEventListener("input", () => {
                let newValue = input.value.toUpperCase().slice(-1)
                if (!allowedHexValues.includes(newValue)) {
                    input.value = ""
                    return
                }

                input.value = newValue
                if (absoluteBlockIndex < totalFblocksLength - 1) {
                    inputOrderMap[absoluteBlockIndex + 1].focus()
                }
            })

            let absoluteBlockIndex = i * numBlocks + blockSizeIndex
            if (absoluteBlockIndex >= shortLength * 2 * numBlocks) {
                const overlap = absoluteBlockIndex - shortLength * 2 * numBlocks + 1
                absoluteBlockIndex -= shortCount * Math.ceil(overlap / numBlocks)
            }

            inputOrderMap[absoluteBlockIndex] = input
            input.dataset.inputOrderKey = absoluteBlockIndex

            input.addEventListener("keydown", event => {
                if (event.key === "Tab") {
                    if (event.shiftKey) {
                        if (absoluteBlockIndex > 0) {
                            inputOrderMap[absoluteBlockIndex - 1].focus()
                            event.preventDefault()
                        }
                    } else if (absoluteBlockIndex < totalFblocksLength - 1) {
                        inputOrderMap[absoluteBlockIndex + 1].focus()
                        event.preventDefault()
                    }
                }
            })

            input.addEventListener("focusin", () => {
                highlightedDatablockIndex = absoluteBlockIndex
                redrawFillCanvas()
            })

            input.addEventListener("focusout", () => {
                highlightedDatablockIndex = null
                redrawFillCanvas()
            })
        }

        elements.byteTablesContainer.appendChild(byteTable)
    }
}

function resetFreeWorkspace() {
    const styles = getComputedStyle(elements.worksheetContainer)
    const paddingTop = parseFloat(styles.paddingTop)
    const paddingBottom = parseFloat(styles.paddingBottom)
    const worksheetHeight = elements.worksheetContainer.clientHeight
    const usableHeight = worksheetHeight - paddingTop - paddingBottom
    const freeWorkspaceTop = elements.freeWorkspace.offsetTop - paddingTop
    const freeSpace = usableHeight - freeWorkspaceTop
    
    if (freeSpace / usableHeight > 0.1) {
        elements.freeWorkspace.style.height = `${freeSpace}px`
        elements.freeWorkspace.classList.add("visible")
    } else {
        elements.freeWorkspace.classList.remove("visible")
    }
}

let fillQr = null
function redrawFillCanvas(printMode=false) {
    const [numBlocks, totalBlocksLength] = VersionECCBlockLayoutTable[qrParameters.version][qrParameters.eccLevel]
    const totalFblocksLength = totalBlocksLength * 2

    fillQr.drawToCanvas(fillContext, {
        drawText: false,
        drawReadPath: true,
        maxReadPathLength: totalFblocksLength * 4,
        highlightedBlockIndex: highlightedDatablockIndex,
        printMode
    })
}

function resetFillCanvas() {
    if (fillQr === null) {
        fillContext.canvas.addEventListener("click", (event) => {
            const cell = fillQr.getCellAtEvent(event, fillContext)
            if (cell?.isMutable) {
                cell.value = !cell.value
            }

            redrawFillCanvas()
        })

        fillContext.canvas.addEventListener("mousemove", (event) => {
            const cell = fillQr.getCellAtEvent(event, fillContext)
            if (!cell) {
                return
            }

            if (cell.isMutable) {
                fillContext.canvas.style.cursor = "pointer"
            } else {
                fillContext.canvas.style.cursor = "initial"
            }
        })
    }

    fillQr = QrCode.fromParameters(qrParameters)
    redrawFillCanvas()
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

function initPrintButton() {
    elements.printButton.addEventListener("click", () => {
        redrawFillCanvas(true)
        window.print()
        redrawFillCanvas()
    })
}

function main() {
    qrParameters = loadQRParameters()
    updateQrParameters()
    initChoiceCanvas()
    initVersionSelect()
    resetFillCanvas()
    initPrintButton()

    window.addEventListener("resize", redrawFillCanvas)
    window.addEventListener("resize", resetFreeWorkspace)
}

window.addEventListener("load", main)