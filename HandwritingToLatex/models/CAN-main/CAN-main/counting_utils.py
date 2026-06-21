import torch
import torch.nn as nn
import torch.nn.functional as F
import numpy as np
import matplotlib.pyplot as plt
import os

def gen_counting_label(labels, channel, tag):
    b, t = labels.size()
    device = labels.device
    counting_labels = torch.zeros((b, channel))
    if tag:
        # Ignore special tokens: pad(0), sos(1), eos(2)
        # Original indices 107-110 were for the 111-class CROHME dataset
        ignore = [0, 1, 2]
    else:
        ignore = []
    for i in range(b):
        for j in range(t):
            k = labels[i][j]
            if k in ignore:
                continue
            else:
                counting_labels[i][k] += 1
    return counting_labels.to(device)
