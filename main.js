// DOM Elements
const videoElement = document.getElementById("video");
const canvasElement = document.getElementById("canvas");
const processedCanvasElement = document.getElementById("processed");
const plateCanvasElement = document.getElementById("plate"); // Canvas para a placa recortada
const startButton = document.getElementById("startButton");
const stopButton = document.getElementById("stopButton");
const resultElement = document.getElementById("result");
const statusElement = document.getElementById("status");

// Global variables
let stream;
let isOpenCvReady = false;
let processingInterval;
let capturedFrame = null; // Armazenar o frame capturado com a placa
let isProcessingFrame = false; // Flag para controlar o estado do processamento
const PLATE_ASPECT_RATIO = 3.0; // Proporção aproximada de placas brasileiras (largura/altura)

// Function called when OpenCV is ready
function onOpenCvReady() {
  console.log("OpenCV script loaded");

  // This will be called when the runtime is actually initialized
  cv.onRuntimeInitialized = () => {
    console.log("OpenCV.js is ready!");
    isOpenCvReady = true;

    // Test OpenCV
    try {
      let mat = new cv.Mat();
      console.log("OpenCV Mat created:", mat.size());
      mat.delete();
    } catch (error) {
      console.error("Error testing OpenCV:", error);
    }
  };
}

// Initialize camera
async function initializeCamera() {
  console.log("Initializing camera...");

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        facingMode: {
          exact: "environment"
        }
      }
    });

    videoElement.srcObject = stream;
    videoElement.play();
    console.log("Camera initialized successfully");
  } catch (err) {
    console.error("Camera initialization error:", err);
  }
}

// Capture frame from video to canvas
function captureVideoFrame() {
  if (!videoElement.videoWidth) {
    console.error("Video not ready yet");
    return false;
  }

  // Set canvas dimensions to match video
  canvasElement.width = videoElement.videoWidth;
  canvasElement.height = videoElement.videoHeight;

  // Also set processed canvas to same dimensions
  processedCanvasElement.width = videoElement.videoWidth;
  processedCanvasElement.height = videoElement.videoHeight;

  // Draw video frame to canvas
  const ctx = canvasElement.getContext("2d");
  ctx.drawImage(videoElement, 0, 0, canvasElement.width, canvasElement.height);

  return true;
}

// Função para detectar e recortar placas de veículos
const detectLicensePlate = (src, dst) => {
  // Criar matrizes para processamento
  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  const edges = new cv.Mat();
  const hierarchy = new cv.Mat();

  try {
    // Converter para escala de cinza
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

    // Aplicar desfoque gaussiano para reduzir ruído
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);

    // Detectar bordas com Canny
    cv.Canny(blurred, edges, 50, 150, 3, false);

    // Dilatação para conectar bordas próximas
    const kernel = cv.Mat.ones(3, 3, cv.CV_8U);
    const dilated = new cv.Mat();
    cv.dilate(edges, dilated, kernel, new cv.Point(-1, -1), 1);

    // Encontrar contornos
    const contours = new cv.MatVector();
    cv.findContours(
      dilated,
      contours,
      hierarchy,
      cv.RETR_EXTERNAL,
      cv.CHAIN_APPROX_SIMPLE
    );

    // Desenhar contornos originais para visualização
    const contoursImage = src.clone();
    cv.drawContours(
      contoursImage,
      contours,
      -1,
      new cv.Scalar(0, 255, 0, 255),
      2
    );
    cv.imshow(processedCanvasElement, contoursImage);

    // Filtrar contornos por área e proporção
    let plateContour = null;
    let maxScore = 0;

    for (let i = 0; i < contours.size(); ++i) {
      const contour = contours.get(i);
      const area = cv.contourArea(contour);

      // Ignorar contornos muito pequenos
      if (area < 1000) {
        continue;
      }

      // Obter retângulo rotacionado de área mínima
      const rotatedRect = cv.minAreaRect(contour);
      const width = rotatedRect.size.width;
      const height = rotatedRect.size.height;

      // Calcular proporção (largura/altura)
      let aspectRatio;
      if (width > height) {
        aspectRatio = width / height;
      } else {
        aspectRatio = height / width;
      }

      // Calcular pontuação baseada na proximidade da proporção ideal de uma placa
      // e na área do contorno (favorecendo contornos maiores)
      const aspectScore = Math.max(
        0,
        1 - Math.abs(aspectRatio - PLATE_ASPECT_RATIO) / 2
      );
      const areaScore = Math.min(area / 10000, 1); // Normalizar área
      const score = aspectScore * 0.7 + areaScore * 0.3; // Pesos: 70% proporção, 30% área

      if (score > maxScore && score > 0.5) {
        // Threshold de pontuação
        maxScore = score;
        plateContour = contour;
      }
    }

    // Se encontrou um contorno de placa
    if (plateContour) {
      // Obter retângulo rotacionado
      const rotatedRect = cv.minAreaRect(plateContour);
      const vertices = cv.RotatedRect.points(rotatedRect);

      // Ordenar os vértices para corresponder aos pontos de destino
      const sortedVertices = sortRectPoints(vertices);

      // Desenhar o retângulo da placa na imagem original
      const plateImage = src.clone();
      for (let i = 0; i < 4; i++) {
        cv.line(
          plateImage,
          sortedVertices[i],
          sortedVertices[(i + 1) % 4],
          new cv.Scalar(255, 0, 0, 255),
          2
        );
      }

      // Mostrar imagem com placa detectada
      cv.imshow(processedCanvasElement, plateImage);

      // Definir pontos de destino para perspectiva
      let plateWidth, plateHeight;
      if (rotatedRect.size.width > rotatedRect.size.height) {
        plateWidth = rotatedRect.size.width;
        plateHeight = rotatedRect.size.height;
      } else {
        plateWidth = rotatedRect.size.height;
        plateHeight = rotatedRect.size.width;
      }

      // Garantir que a placa tenha proporção correta
      plateHeight = plateWidth / PLATE_ASPECT_RATIO;

      // Calcular as dimensões do recorte interno (apenas a área branca central)
      // Reduzir a altura para remover a parte superior com "BRASIL" e a parte inferior
      const whiteCenterHeightRatio = 0.65; // 65% da altura total para focar na área branca
      const topMarginRatio = 0.25; // 25% de margem superior para remover "BRASIL"

      const whiteAreaHeight = plateHeight * whiteCenterHeightRatio;
      const topMargin = plateHeight * topMarginRatio;

      // Reduzir a largura para remover a parte lateral com "BR"
      const whiteCenterWidthRatio = 0.9; // 90% da largura total
      const leftMarginRatio = 0.05; // 5% de margem esquerda

      const whiteAreaWidth = plateWidth * whiteCenterWidthRatio;
      const leftMargin = plateWidth * leftMarginRatio;

      // Pontos de destino para a placa inteira (para a transformação de perspectiva)
      const dstPoints = [
        new cv.Point(0, 0),
        new cv.Point(plateWidth - 1, 0),
        new cv.Point(plateWidth - 1, plateHeight - 1),
        new cv.Point(0, plateHeight - 1)
      ];

      // Converter para matrizes JavaScript
      const srcPointsArray = sortedVertices.map((pt) => [pt.x, pt.y]);
      const dstPointsArray = dstPoints.map((pt) => [pt.x, pt.y]);

      // Criar matrizes OpenCV para os pontos
      const srcPoints = cv.matFromArray(
        4,
        1,
        cv.CV_32FC2,
        [].concat(...srcPointsArray)
      );
      const dstPointsMat = cv.matFromArray(
        4,
        1,
        cv.CV_32FC2,
        [].concat(...dstPointsArray)
      );

      // Calcular matriz de perspectiva
      const perspectiveMatrix = cv.getPerspectiveTransform(
        srcPoints,
        dstPointsMat
      );

      // Aplicar transformação de perspectiva para obter a placa inteira retificada
      const warpedPlate = new cv.Mat();
      cv.warpPerspective(
        src,
        warpedPlate,
        perspectiveMatrix,
        new cv.Size(plateWidth, plateHeight)
      );

      // Recortar apenas a área branca central da placa (onde estão os caracteres)
      const plateRect = new cv.Rect(
        Math.round(leftMargin), // x - margem esquerda
        Math.round(topMargin), // y - margem superior
        Math.round(whiteAreaWidth), // largura da área branca
        Math.round(whiteAreaHeight) // altura da área branca
      );

      // Extrair a região de interesse (ROI)
      const plateROI = warpedPlate.roi(plateRect);

      // Configurar canvas para a placa recortada
      plateCanvasElement.width = plateRect.width;
      plateCanvasElement.height = plateRect.height;

      // Mostrar apenas a área branca central da placa
      cv.imshow(plateCanvasElement, plateROI);

      // Limpar recursos
      plateROI.delete();
      warpedPlate.delete();
      srcPoints.delete();
      dstPointsMat.delete();
      perspectiveMatrix.delete();

      return {
        found: true,
        canvas: plateCanvasElement
      };
    }

    // Limpar recursos
    kernel.delete();
    dilated.delete();
    contoursImage.delete();

    return { found: false };
  } finally {
    // Limpar recursos OpenCV
    gray.delete();
    blurred.delete();
    edges.delete();
    hierarchy.delete();
  }
};

// Função auxiliar para ordenar os pontos do retângulo
const sortRectPoints = (points) => {
  // Converter para array JavaScript
  const pointsArray = [];
  for (let i = 0; i < 4; i++) {
    pointsArray.push({ x: points[i].x, y: points[i].y });
  }

  // Calcular o centro
  const center = {
    x: pointsArray.reduce((sum, pt) => sum + pt.x, 0) / 4,
    y: pointsArray.reduce((sum, pt) => sum + pt.y, 0) / 4
  };

  // Ordenar pontos com base no ângulo em relação ao centro
  pointsArray.sort((a, b) => {
    const angleA = Math.atan2(a.y - center.y, a.x - center.x);
    const angleB = Math.atan2(b.y - center.y, b.x - center.x);
    return angleA - angleB;
  });

  // Reordenar para ter o ponto superior esquerdo primeiro
  // Encontrar o ponto com menor soma de coordenadas (mais próximo do canto superior esquerdo)
  let minIndex = 0;
  let minSum = Infinity;

  for (let i = 0; i < 4; i++) {
    const sum = pointsArray[i].x + pointsArray[i].y;
    if (sum < minSum) {
      minSum = sum;
      minIndex = i;
    }
  }

  // Reorganizar o array para começar pelo ponto superior esquerdo
  const result = [];
  for (let i = 0; i < 4; i++) {
    result.push(pointsArray[(i + minIndex) % 4]);
  }

  return result;
};

// Process image with OpenCV
const processImage = async () => {
  // Check if OpenCV is ready
  if (!isOpenCvReady) {
    console.error("OpenCV is not ready yet");
    resultElement.textContent = "OpenCV não está pronto. Aguarde...";
    return;
  }

  // Se já estamos processando um frame capturado, não capture novos frames
  if (isProcessingFrame && capturedFrame) {
    return;
  }

  // Capture frame from video
  if (!captureVideoFrame()) {
    resultElement.textContent = "Câmera não está pronta";
    return;
  }

  try {
    // Create OpenCV matrices
    let src = cv.imread(canvasElement);

    console.log("Processing image with dimensions:", src.cols, "x", src.rows);

    // Check if source image has data
    if (src.empty()) {
      console.error("Source image is empty");
      resultElement.textContent = "Erro: imagem fonte vazia";
      return;
    }

    // Pré-processamento básico
    let gray = new cv.Mat();
    let filtered = new cv.Mat();

    // Converter para escala de cinza
    cv.cvtColor(src, gray, cv.COLOR_BGR2GRAY);

    // Aplicar filtro bilateral para reduzir ruído preservando bordas
    cv.bilateralFilter(gray, filtered, 9, 75, 75, cv.BORDER_DEFAULT);

    // Detectar e recortar placa
    const plateResult = detectLicensePlate(src, processedCanvasElement);

    if (plateResult.found) {
      // Se encontrou uma placa e não estamos processando um frame capturado
      if (!isProcessingFrame) {
        // Parar o processamento contínuo
        if (processingInterval) {
          clearInterval(processingInterval);
          processingInterval = null;
        }

        // Capturar o frame atual
        capturedFrame = src.clone();
        isProcessingFrame = true;

        // Notificar o usuário
        resultElement.textContent =
          "Placa detectada! Processando imagem capturada...";

        // Continuar o processamento com o frame capturado
        setTimeout(() => processPlateFrame(plateResult), 100);

        return;
      }

      // Se já estamos processando um frame capturado, continuar com o processamento
      await processPlateFrame(plateResult);
    } else {
      // Se não encontrou placa e não estamos processando um frame capturado
      if (!isProcessingFrame) {
        resultElement.textContent = "Procurando placa...";
      } else {
        resultElement.textContent = "Nenhuma placa detectada.";
      }
    }

    // Clean up OpenCV objects
    src.delete();
    gray.delete();
    filtered.delete();
  } catch (error) {
    console.error("Error processing image:", error);
    resultElement.textContent = "Erro no processamento: " + error.message;
  }
};

// Função para processar o frame capturado com a placa
const processPlateFrame = async (plateResult) => {
  try {
    // Aplicar processamento adicional na imagem da placa para melhorar OCR
    const plateImage = cv.imread(plateResult.canvas);

    // Criar matrizes para diferentes processamentos
    const plateGray = new cv.Mat();
    const plateBlurred = new cv.Mat();
    const plateThresh = new cv.Mat();
    const plateSharpened = new cv.Mat();
    const plateResized = new cv.Mat();

    // Converter para escala de cinza
    cv.cvtColor(plateImage, plateGray, cv.COLOR_RGBA2GRAY);

    // Aplicar desfoque Gaussiano para reduzir ruído
    cv.GaussianBlur(plateGray, plateBlurred, new cv.Size(3, 3), 0);

    // Aplicar CLAHE (Contrast Limited Adaptive Histogram Equalization) para melhorar contraste
    const clahe = new cv.CLAHE(3.0, new cv.Size(8, 8));
    clahe.apply(plateBlurred, plateSharpened);

    // Aplicar limiarização OTSU para binarização
    cv.threshold(
      plateSharpened,
      plateThresh,
      0,
      255,
      cv.THRESH_BINARY + cv.THRESH_OTSU
    );

    // Redimensionar a imagem para melhorar o OCR (aumentar tamanho)
    const scaleFactor = 2.0; // Dobrar o tamanho
    const newWidth = Math.round(plateThresh.cols * scaleFactor);
    const newHeight = Math.round(plateThresh.rows * scaleFactor);
    cv.resize(
      plateThresh,
      plateResized,
      new cv.Size(newWidth, newHeight),
      0,
      0,
      cv.INTER_CUBIC
    );

    // Aplicar operações morfológicas para melhorar a qualidade dos caracteres
    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(2, 2));
    const plateProcessed = new cv.Mat();

    // Dilatação seguida de erosão (fechamento) para conectar partes de caracteres
    cv.morphologyEx(
      plateResized,
      plateProcessed,
      cv.MORPH_CLOSE,
      kernel,
      new cv.Point(-1, -1),
      1
    );

    // Mostrar a imagem processada no canvas da placa
    cv.imshow(plateCanvasElement, plateProcessed);

    // Converter canvas da placa processada para base64 para Tesseract
    const dataURL = plateCanvasElement.toDataURL("image/png");

    // Criar link para download da imagem da placa processada
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const downloadLink = document.createElement("a");
    downloadLink.href = dataURL;
    downloadLink.download = `placa_processada_${timestamp}.png`;
    downloadLink.className = "download-link";
    downloadLink.textContent = "Baixar imagem da placa";

    // Remover links anteriores se existirem
    const oldLinks = document.querySelectorAll(".download-link");
    oldLinks.forEach((link) => link.remove());

    // Adicionar o link ao elemento de resultado
    resultElement.textContent = "Processando OCR na placa...";
    resultElement.appendChild(document.createElement("br"));
    resultElement.appendChild(downloadLink);

    // Realizar OCR na imagem processada com configurações específicas para placas
    const {
      data: { text }
    } = await Tesseract.recognize(dataURL, "por", {
      logger: (m) => console.log(m),
      tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", // Apenas letras e números
      tessedit_pageseg_mode: "7" // Modo de segmentação: linha única
    });

    // Lista de palavras a serem ignoradas (como "BRASIL" que aparece nas placas)
    const wordsToIgnore = ["BRASIL", "BR", "MERCOSUL"];

    // Processar o texto reconhecido
    let processedText = text.trim();

    // Remover as palavras a serem ignoradas
    wordsToIgnore.forEach((word) => {
      const regex = new RegExp(word, "gi"); // case insensitive
      processedText = processedText.replace(regex, "");
    });

    // Remover caracteres inválidos e espaços
    processedText = processedText.replace(/[^A-Z0-9]/g, "").toUpperCase();

    // Formatar o texto para o padrão de placa brasileira (se possível)
    if (processedText.length >= 7) {
      // Tentar formatar como placa padrão (AAA0000 ou AAA0A00)
      const isNewFormat = /[A-Z]{3}[0-9][A-Z][0-9]{2}/.test(
        processedText.substring(0, 7)
      );
      const isOldFormat = /[A-Z]{3}[0-9]{4}/.test(
        processedText.substring(0, 7)
      );

      if (isNewFormat || isOldFormat) {
        // Extrair apenas os 7 caracteres da placa
        processedText = processedText.substring(0, 7);
      }
    }

    // Limpar recursos OpenCV
    plateImage.delete();
    plateGray.delete();
    plateBlurred.delete();
    plateThresh.delete();
    plateSharpened.delete();
    plateResized.delete();
    plateProcessed.delete();
    kernel.delete();
    clahe.delete();

    // Mostrar resultado do OCR
    resultElement.innerHTML =
      `<strong>Texto reconhecido:</strong> ${
        processedText || "Nenhum texto reconhecido na placa."
      }` +
      `<br><a href="${dataURL}" download="placa_processada_${timestamp}.png" class="download-link">Baixar imagem da placa</a>` +
      `<br><button id="resetButton" class="controls__button controls__button--reset">Capturar nova placa</button>`;

    // Adicionar evento ao botão de reset
    document
      .getElementById("resetButton")
      .addEventListener("click", resetCapture);
  } catch (error) {
    console.error("Error processing plate:", error);
    resultElement.textContent =
      "Erro no processamento da placa: " + error.message;

    // Adicionar botão de reset mesmo em caso de erro
    resultElement.innerHTML += `<br><button id="resetButton" class="controls__button controls__button--reset">Tentar novamente</button>`;
    document
      .getElementById("resetButton")
      .addEventListener("click", resetCapture);
  }
};

// Função para resetar a captura
const resetCapture = () => {
  // Limpar o frame capturado
  if (capturedFrame) {
    capturedFrame.delete();
    capturedFrame = null;
  }

  // Resetar o estado de processamento
  isProcessingFrame = false;

  // Reiniciar o processamento contínuo
  if (!processingInterval) {
    processingInterval = setInterval(async () => {
      await processImage();
    }, 500);
  }

  resultElement.textContent = "Procurando nova placa...";
};

// Handle start button click
const handleStartButton = async () => {
  // Resetar o estado de processamento
  if (capturedFrame) {
    capturedFrame.delete();
    capturedFrame = null;
  }
  isProcessingFrame = false;

  resultElement.textContent = "Processando...";

  // Iniciar processamento contínuo
  if (!processingInterval) {
    processingInterval = setInterval(async () => {
      await processImage();
    }, 500); // Processar a cada 500ms
  }
};

// Handle stop button click
const handleStopButton = () => {
  // Parar o processamento contínuo
  if (processingInterval) {
    clearInterval(processingInterval);
    processingInterval = null;
  }

  // Limpar o frame capturado
  if (capturedFrame) {
    capturedFrame.delete();
    capturedFrame = null;
  }

  // Resetar o estado de processamento
  isProcessingFrame = false;

  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
    resultElement.textContent = "Câmera desligada";
  }
};

// Add event listeners
startButton.addEventListener("click", handleStartButton);
stopButton.addEventListener("click", handleStopButton);

// Initialize the application
initializeCamera();
